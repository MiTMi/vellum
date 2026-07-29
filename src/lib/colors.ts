export const SELECT_COLORS = [
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
] as const;

export function randomColor(): string {
  return SELECT_COLORS[Math.floor(Math.random() * SELECT_COLORS.length)];
}

export const COVER_GRADIENTS = [
  "linear-gradient(120deg, #fdfbfb 0%, #ebedee 100%)",
  "linear-gradient(120deg, #a1c4fd 0%, #c2e9fb 100%)",
  "linear-gradient(120deg, #fbc2eb 0%, #a6c1ee 100%)",
  "linear-gradient(120deg, #ffecd2 0%, #fcb69f 100%)",
  "linear-gradient(120deg, #84fab0 0%, #8fd3f4 100%)",
  "linear-gradient(120deg, #d299c2 0%, #fef9d7 100%)",
  "linear-gradient(120deg, #667eea 0%, #764ba2 100%)",
  "linear-gradient(120deg, #2c3e50 0%, #4ca1af 100%)",
  "linear-gradient(120deg, #f83600 0%, #f9d423 100%)",
  "linear-gradient(120deg, #0ba360 0%, #3cba92 100%)",
];

export function coverBackground(cover: string): string {
  if (cover.startsWith("gradient:")) {
    const i = parseInt(cover.slice(9), 10);
    return COVER_GRADIENTS[i % COVER_GRADIENTS.length];
  }
  return `url("${cover}") center / cover no-repeat`;
}
