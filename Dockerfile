FROM python:3.12-slim

WORKDIR /app
COPY server/serve.py .

ENV PYTHONUNBUFFERED=1
ENV PORT=80

EXPOSE 80
CMD ["python3", "serve.py"]
