FROM python:3.12-slim
WORKDIR /app
COPY web_demo/requirements.txt web_demo/requirements.txt
RUN pip install --no-cache-dir -r web_demo/requirements.txt
COPY qns qns
COPY web_demo web_demo
USER 10001:10001
EXPOSE 8000
CMD ["python", "web_demo/server.py", "--host", "0.0.0.0", "--port", "8000"]
