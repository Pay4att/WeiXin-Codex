const IMAGE_GENERATION_PATTERNS = [
  /(?:生成|画|绘制|创作|制作|创建|设计).{0,16}(?:图|图片|图像|照片|海报|头像|插画|壁纸|表情包)/i,
  /(?:图|图片|图像|照片|海报|头像|插画|壁纸|表情包).{0,12}(?:生成|画|绘制|创作|制作|创建|设计)/i,
  /(?:generate|create|draw|make|design).{0,24}(?:image|picture|photo|poster|avatar|illustration|wallpaper)/i,
];

export function isImageGenerationRequest(text) {
  const value = String(text || "").trim();
  return value.length > 0 && IMAGE_GENERATION_PATTERNS.some((pattern) => pattern.test(value));
}

export const IMAGE_GENERATION_ACK = "收到，正在生成图片，通常需要几十秒，请稍等…";
