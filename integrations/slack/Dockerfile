FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir slack-bolt python-dotenv openai httpx
COPY slack_local_llm.py /app/slack_local_llm.py
CMD ["python", "/app/slack_local_llm.py"]
