"""Canvex 的主 app —— 画布、生成 job、通道配置全在这儿。

**关于代码里到处出现的「上游」**: Canvex 是从一个多租户版本里剥出来的独立版。那个版本有
组织 / 鉴权 / 计费 / 共享的 library 资产库, Canvex 都没有 —— 它是单工作区、免费、无鉴权。
所以你会在注释里反复读到"上游怎样, 而 Canvex 怎样": 那不是闲话, 是在解释**某段代码为什么
长成这样**。最典型的三处:

- `permissions.py` —— 整个文件的存在理由: 上游按 organization 过滤 queryset, 这里退化成
  一组保留了签名但不做任何过滤的函数。
- `services/billing.py` —— 全是空操作, 只为了让 port 过来的代码零改动能跑。
- `models.py` 的 DataAsset / DataFolder —— 上游用独立的 library app, 这里复用自己的。

改这些地方之前先读那段注释: 它记的是"为什么不是另一种写法"。
"""
