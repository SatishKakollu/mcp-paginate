/**
 * Exact token counter using tiktoken cl100k_base.
 * Compatible with GPT-4 and Claude tokenizers.
 *
 * Requires @dqbd/tiktoken as a peer dependency:
 *   npm install @dqbd/tiktoken
 *
 * Usage:
 *   import { tiktokenCounter } from "mcp-pager/tiktoken";
 *   paginate(server, { tokenCounter: tiktokenCounter });
 */
import { get_encoding } from "@dqbd/tiktoken";

const enc = get_encoding("cl100k_base");

/** Drop-in tokenCounter using exact tiktoken encoding. */
export const tiktokenCounter = (text: string): number =>
  enc.encode(text).length;
