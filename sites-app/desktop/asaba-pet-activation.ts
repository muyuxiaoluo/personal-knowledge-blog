/** Keep one native window transition per click burst, including after a resize
 * resets the WebView's click count. The first click responds immediately. */
export class AsabaPetActivation {
  private lastAccepted = -Infinity;
  private pending = false;

  begin(detail: number, now: number) {
    if (this.pending || detail > 1 || now - this.lastAccepted < 600) return false;
    this.lastAccepted = now;
    this.pending = true;
    return true;
  }

  finish() { this.pending = false; }
}
