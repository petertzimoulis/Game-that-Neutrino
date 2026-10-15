"""Independent production API, served by Gunicorn behind nginx."""
from __future__ import annotations

import json
import math
import os
import time
from datetime import datetime, timezone
from threading import Lock
from urllib.parse import urlparse

import psycopg
from flask import Flask, jsonify, request
from psycopg_pool import PoolTimeout, TooManyRequests
from werkzeug.exceptions import HTTPException

from database import Store
import server as rules
from accounts import AccountStore, AccountError, ROUTES as ACCOUNT_ROUTES, session_cookie
from endless import EndlessStore, EndlessError

ROUTES = {"players": "friday", "collaborator-players": "demo", "quiz-players": "quiz", "quick-quiz-players": "quick"}


def timestamp(value):
    if not isinstance(value, str) or len(value) > 80:
        raise ValueError("Invalid timestamp")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.utcoffset() is None:
            raise ValueError("Timestamp needs a timezone")
        return result.astimezone(timezone.utc).isoformat()
    except (ValueError, OverflowError) as error:
        raise ValueError("Invalid timestamp") from error


def validate_run(mode, payload):
    if mode == "demo":
        record = rules.validate_collaborator_record(payload)
    else:
        record = dict(payload)
    for key, maximum in [("id", 120), ("name", 80)]:
        if not isinstance(record.get(key), str) or not record[key].strip() or len(record[key]) > maximum:
            raise ValueError(f"Invalid {key}")
    answers = record.get("answers")
    expected = {"demo": 5, "friday": rules.RUN_VIDEO_COUNT, "quiz": 10}.get(mode)
    if not isinstance(answers, list) or not 1 <= len(answers) <= 100 or (expected and len(answers) != expected):
        raise ValueError("Submit a complete run")
    seen = set()
    for answer in answers:
        if not isinstance(answer, dict) or not isinstance(answer.get("videoId"), str) or len(answer["videoId"]) > 240:
            raise ValueError("Invalid answer")
        video_id = answer["videoId"]
        if video_id in seen or not isinstance(answer.get("choice"), str) or answer["choice"] not in {"track", "cascade", "undecided"} or not isinstance(answer.get("correct"), bool):
            raise ValueError("Invalid or duplicate answer")
        seen.add(video_id)
    coins = record.get("finalCoins")
    if mode != "quiz" and (isinstance(coins, bool) or not isinstance(coins, (int, float)) or not math.isfinite(coins) or abs(coins) > 10000):
        raise ValueError("Invalid coin total")
    if mode == "quiz":
        record["finalCoins"] = None
    correct = sum(answer["correct"] for answer in answers)
    record.update(mode=mode, name=record["name"].strip(), nameKey=" ".join(record["name"].lower().split()),
                  completedAt=timestamp(record.get("completedAt")), totalCorrect=correct,
                  totalQuestions=len(answers), totalAccuracy=correct / len(answers))
    if mode == "friday":
        if record.get("cycleStart") != rules.get_active_cycle_start().isoformat():
            raise ValueError("Weekly lineup changed. Start a fresh run for the current Friday slate.")
    return record


def validate_events(payload):
    events = payload.get("events")
    if not isinstance(events, list) or not 1 <= len(events) <= 100:
        raise ValueError("Supply 1–100 events per batch")
    result = []
    for event in events:
        if not isinstance(event, dict):
            raise ValueError("Invalid event")
        for field, maximum in [("id", 120), ("type", 80)]:
            if not isinstance(event.get(field), str) or not event[field] or len(event[field]) > maximum:
                raise ValueError(f"Invalid event {field}")
        for field in ["sessionId", "nameKey", "mode"]:
            if event.get(field) is not None and (not isinstance(event[field], str) or len(event[field]) > 160):
                raise ValueError(f"Invalid event {field}")
        result.append({**event, "timestamp": timestamp(event.get("timestamp"))})
    return result


def create_app(store=None):
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = 262144
    app.json.sort_keys = False
    app.json.ensure_ascii = False
    db = store or Store()
    accounts = AccountStore(lambda: db.pool.connection(), postgres=True)
    endless = EndlessStore(accounts)
    app.extensions["store"] = db
    cache = {}
    locks = {key: Lock() for key in [*ROUTES, "achievements", "analytics", "endless"]}

    def body():
        payload = request.get_json()
        if not isinstance(payload, dict):
            raise ValueError("Expected an object")
        return payload

    def public_payload(key, loader):
        # Shared nginx cache + a per-worker guard also protects uncached startup bursts.
        with locks[key]:
            cached = cache.get(key)
            if cached is None or cached[0] <= time.monotonic():
                cached = (time.monotonic() + 10, app.json.dumps(loader()))
                cache[key] = cached
        response = app.response_class(cached[1], mimetype="application/json")
        response.headers["Cache-Control"] = "public, max-age=0, s-maxage=15, stale-while-revalidate=15"
        response.add_etag()
        return response.make_conditional(request)

    @app.after_request
    def headers(response):
        response.headers.setdefault("Cache-Control", "no-store")
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get("/api/health")
    def health():
        return jsonify(status="ok")

    @app.route("/api/endless-players", methods=["GET", "POST"])
    def endless_api():
        try:
            if request.method == "GET":
                return public_payload("endless", endless.leaderboard)
            record = endless.save(body())
            return jsonify(record=record, player=endless.best_for_player(record["nameKey"]))
        except EndlessError as error:
            return jsonify(error=str(error)), error.status

    @app.route("/api/account", methods=["GET"])
    @app.route("/api/account/progress", methods=["POST"])
    @app.route("/api/auth/<action>", methods=["POST"])
    def account_api(action=None):
        if request.path not in ACCOUNT_ROUTES:
            return jsonify(error="Not found"), 404
        try:
            payload, token = accounts.handle(request.method, request.path,
                body() if request.method == "POST" else None, request.headers, request.remote_addr or "unknown")
            response = jsonify(payload)
            response.headers["Cache-Control"] = "private, no-store"
            if token is not None:
                hostname = urlparse("//" + request.host).hostname
                response.headers["Set-Cookie"] = session_cookie(token, secure=hostname not in {"localhost", "127.0.0.1", "::1"})
            return response
        except AccountError as error:
            response = jsonify(error.payload)
            response.status_code = error.status
            response.headers["Cache-Control"] = "private, no-store"
            if error.status == 429:
                response.headers["Retry-After"] = "900"
            return response

    @app.get("/site-config.js")
    def site_config():
        config = {"videoBaseUrl": os.environ.get("VIDEO_BASE_URL", "").rstrip("/")}
        response = app.response_class("window.NEUTRINO_CONFIG = " + json.dumps(config) + ";\n", mimetype="text/javascript")
        response.headers["Cache-Control"] = "public, max-age=60"
        return response

    @app.get("/api/ready")
    def ready():
        db.ready()
        return jsonify(status="ok", storage="postgresql")

    @app.route("/api/<resource>", methods=["GET", "POST"])
    def api(resource):
        if resource in ROUTES:
            mode = ROUTES[resource]
            if request.method == "GET":
                if request.args.get("view") == "full":
                    return jsonify(db.leaderboard(mode, full=True))
                return public_payload(resource, lambda: db.leaderboard(mode))
            record = validate_run(mode, body())
            payload = db.save_run(mode, record)
            if mode == "friday":
                payload.update(db.schedule())
            return jsonify(payload)
        if resource == "history" and request.method == "GET":
            mode = request.args.get("mode")
            if mode not in ROUTES.values():
                raise ValueError("Invalid history mode")
            cursor = request.args.get("cursor")
            after = json.loads(cursor) if cursor else None
            if after is not None:
                if not isinstance(after, list) or len(after) != 2 or not isinstance(after[1], str) or len(after[1]) > 120:
                    raise ValueError("Invalid history cursor")
                after[0] = timestamp(after[0])
            return jsonify(db.history(mode, after))
        if resource == "achievements":
            if request.method == "POST":
                return jsonify(db.save_achievements(body()))
            return public_payload(resource, db.achievements)
        if resource == "analytics" and request.method == "GET":
            return public_payload(resource, db.analytics)
        if resource == "analytics-events" and request.method == "POST":
            return jsonify(db.save_events(validate_events(body())))
        return jsonify(error="Not found"), 404

    @app.errorhandler(ValueError)
    def invalid(error):
        return jsonify(error=str(error)), 409 if "Weekly lineup changed" in str(error) else 400

    @app.errorhandler(HTTPException)
    def http_error(error):
        return jsonify(error=error.description), error.code

    @app.errorhandler(psycopg.Error)
    @app.errorhandler(PoolTimeout)
    @app.errorhandler(TooManyRequests)
    def unavailable(error):
        app.logger.exception("Database request failed")
        response = jsonify(error="Shared data is temporarily busy. Please retry shortly.")
        response.status_code = 503
        response.headers["Retry-After"] = "5"
        return response

    return app
