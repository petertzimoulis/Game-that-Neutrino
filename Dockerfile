FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home neutrino
COPY server.py accounts.py endless.py database.py production.py manage.py gunicorn.conf.py ./
COPY migrations ./migrations
COPY videos ./videos
USER neutrino
EXPOSE 8000
CMD ["gunicorn", "--config", "gunicorn.conf.py", "production:create_app()"]
