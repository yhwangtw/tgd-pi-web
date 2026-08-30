/**
 * Turn navigation (⌥↑ / ⌥↓): pick which user message to jump to, given the
 * viewport-relative top offsets of every user message in document order.
 *
 * "prev" = the last message that starts above the viewport top;
 * "next" = the first message that starts below it. The epsilon keeps the
 * message currently aligned at the top from matching itself, so repeated
 * presses walk turn by turn — it must stay larger than the .msg-item
 * scroll-margin-top (10px), which offsets the settled alignment position.
 */
export function pickTurnTarget(tops: number[], dir: "prev" | "next"): number | null {
  const EPS = 16;
  if (dir === "next") {
    for (let i = 0; i < tops.length; i++) {
      if (tops[i] > EPS) return i;
    }
    return null;
  }
  for (let i = tops.length - 1; i >= 0; i--) {
    if (tops[i] < -EPS) return i;
  }
  return null;
}

export type MessageFocusDirection = "prev" | "next" | "first" | "last";

/**
 * Pick the next tab stop for keyboard navigation inside the transcript.
 * Only one message is tabbable at a time; arrow keys move that tab stop
 * without putting every historical message into the page's normal tab order.
 */
export function pickRovingMessageTarget(
  currentIndex: number,
  messageCount: number,
  direction: MessageFocusDirection,
): number | null {
  if (messageCount <= 0) return null;
  if (direction === "first") return 0;
  if (direction === "last") return messageCount - 1;

  const target = currentIndex + (direction === "next" ? 1 : -1);
  return target >= 0 && target < messageCount ? target : null;
}
