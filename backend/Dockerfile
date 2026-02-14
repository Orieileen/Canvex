# backend/Dockerfile
FROM python:3.13

# 防止 Python 写 .pyc 文件
ENV PYTHONDONTWRITEBYTECODE=1
# 确保日志立即输出（不走缓冲区）
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# 安装系统依赖，解决 cv2 ImportError: libGL.so.1 缺失
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# 安装 Python 依赖
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

COPY . /app/
