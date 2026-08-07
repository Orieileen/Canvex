# backend/Dockerfile
FROM python:3.13

# 防止 Python 写 .pyc 文件
ENV PYTHONDONTWRITEBYTECODE=1
# 确保日志立即输出（不走缓冲区）
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# 安装系统依赖，解决 cv2 ImportError: libGL.so.1 缺失
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libgl1 \
    libglib2.0-0 \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# 安装 Python 依赖 —— 装的是 LOCK(全量含传递依赖),不是 requirements.txt。
# requirements.txt 是人读的直接依赖清单;改完它要重新生成 lock,见该文件头部。
COPY requirements.lock.txt /app/
# --retries/--timeout: 锁定后每个包都是精确版本, 单个包的元数据拉取失败就会整层构建失败,
# 而不像未锁定时还能退而求其次。默认 5 次重试在网络抖动的环境下不够。
RUN pip install --no-cache-dir --retries 10 --timeout 60 -r requirements.lock.txt

COPY . /app/
