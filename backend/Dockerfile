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

# 抠图用的 u2net 模型 (168MB) 预下载进镜像。不烤进来的话 rembg 会在**用户第一次抠图时**
# 现从 GitHub release 拉,画布上只有一个转圈的占位框、没有任何"正在下模型"的提示;
# 而且它落在容器可写层而不是 volume,`docker compose down` 之后要重下一遍。
# 拉不动就让构建当场失败 —— 反正第 1 步 git clone 已经要求 GitHub 可达了,
# 总好过装完之后抠图莫名其妙卡死。
# 放在 `COPY . /app/` 之前:改后端代码不会让这一层失效。
RUN python -c "from rembg import new_session; new_session('u2net')"

COPY . /app/
