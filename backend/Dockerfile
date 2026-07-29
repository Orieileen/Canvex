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

# 安装 Python 依赖
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# Agentic 浏览器功能依赖（browse / web_operator）：browser-use + Playwright + Chromium。
# 放在业务代码 COPY 之前，改代码不会重建这层重依赖(约 +500MB Chromium + 系统库)。
# 注意：backend 与 workers 共用本镜像，都会带上；只有 CANVAS_BROWSER_ENABLED/
# CANVAS_BROWSER_OPERATOR_ENABLED 打开时才会真正用到。要瘦身可删掉这两行、改回运行时按需装。
COPY requirements-browser.txt /app/
RUN pip install --no-cache-dir -r requirements-browser.txt \
    && python -m playwright install --with-deps chromium

# Xvfb：给「有头」Chromium（CANVAS_BROWSER_HEADLESS=false，反爬识别率更低）提供一块
# 内存虚拟屏。单独一层，避免动到上面那层重依赖（Chromium ~500MB）的缓存。无头默认不用它。
RUN apt-get update && apt-get install -y --no-install-recommends xvfb \
    && rm -rf /var/lib/apt/lists/*

# entrypoint：仅当配置为有头时拉起 Xvfb 并导出 DISPLAY，再 exec 容器的 CMD。
# 放在 /usr/local/bin（不受 ./backend:/app 卷挂载覆盖）。
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

COPY . /app/
