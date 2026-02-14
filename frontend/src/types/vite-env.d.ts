/// <reference types="vite/client" />

// 声明CSS文件的类型，以便TypeScript识别CSS导入
declare module "*.css" {
  const content: Record<string, string>;
  export default content;
}

declare module "*.scss" {
  const content: Record<string, string>;
  export default content;
}

declare module "*.sass" {
  const content: Record<string, string>;
  export default content;
}

declare module "*.less" {
  const content: Record<string, string>;
  export default content;
}
