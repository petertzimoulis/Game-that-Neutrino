import os

bind = os.environ.get("BIND", "0.0.0.0:8000")
workers = int(os.environ.get("WEB_WORKERS", "4"))
worker_class = "gthread"
threads = int(os.environ.get("WEB_THREADS", "8"))
backlog = 4096
timeout = 30
graceful_timeout = 30
keepalive = 5
max_requests = 10000
max_requests_jitter = 1000
accesslog = None
errorlog = "-"
capture_output = True
preload_app = False
