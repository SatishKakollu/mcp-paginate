/** Lightweight token estimator: ~4 chars per token (GPT/Claude average). */
export function defaultTokenCounter(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateContentTokens(
  content: unknown,
  counter: (text: string) => number
): number {
  return counter(JSON.stringify(content));
}
