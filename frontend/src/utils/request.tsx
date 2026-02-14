import axios from 'axios'

// 优先使用构建时注入的 VITE_API_URL；开发模式下默认指向本地后端。
const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:8000' : '')

const request = axios.create({
  baseURL: API_URL,
  timeout: 600000,
})

request.interceptors.request.use(
  (config) => {
    config.headers = config.headers || {}
    // 兼容 ngrok 预检/警告页
    config.headers['ngrok-skip-browser-warning'] = 'true'
    if ((config.method || 'get').toLowerCase() === 'get') {
      // Use a cache-busting query param without introducing extra CORS headers.
      const stamp = Date.now()
      if (config.params instanceof URLSearchParams) {
        config.params.set('_ts', String(stamp))
      } else {
        const params = (config.params && typeof config.params === 'object')
          ? config.params as Record<string, unknown>
          : {}
        config.params = { ...params, _ts: stamp }
      }
    }
    return config
  },
  (error) => Promise.reject(error),
)

request.interceptors.response.use(
  (response) => response,
  (error) => Promise.reject(error),
)

export { request }
