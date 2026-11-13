import { parseReading, normalize, validateTransition } from '../worker/domain.js';

// A count decrease is the opening boundary. Text is never used as an event ID.
// The game badge and the top chest row must both be calibrated and visible.
export class CaptureMachine {
  constructor({ initialBadge, onEvent, onPause, onBaseline }) {
    this.badge = initialBadge;
    this.onEvent = onEvent;
    this.onPause = onPause;
    this.onBaseline = onBaseline;
    this.stable = null;
    this.candidate = null;
    this.pendingBadge = null;
    this.paused = false;
  }

  observe({ badge, badgeConfidence, text, confidence, evidence, capturedAt }) {
    if (this.paused) return;
    if (!Number.isInteger(badge) || badge < 0 || badgeConfidence < 90) {
      // Retain the last settled row across an opening animation, but never adopt an unreadable badge.
      return;
    }
    if (badge === this.badge) {
      this.pendingBadge = null;
      const parsed = parseReading(text);
      if (!parsed.playerName || !parsed.chestName || !parsed.source || confidence < 65) return;
      const key = [parsed.playerName, parsed.chestName, parsed.source].map(normalize).join('|');
      if (this.candidate?.key === key) {
        this.candidate = { ...this.candidate, consensus: this.candidate.consensus + 1, confidence: Math.min(this.candidate.confidence, confidence), evidence, capturedAt };
      } else {
        this.candidate = { key, rawText: text, confidence, evidence, consensus: 1, capturedAt };
      }
      if (this.candidate.consensus >= 2) {
        this.stable = { ...this.candidate };
        this.onBaseline?.({ badge, ...this.stable });
      }
      return;
    }
    if (this.pendingBadge?.value === badge) this.pendingBadge.frames++;
    else this.pendingBadge = { value: badge, frames: 1 };
    if (this.pendingBadge.frames < 2) return;

    if (!validateTransition(this.badge, badge)) {
      this.paused = true;
      this.onPause?.(badge > this.badge ? 'The gift count increased. New chests may have arrived. Recheck the top row, then resume with a new baseline.' : 'More than one chest disappeared between readings. Review those chests manually, then resume with a new baseline.');
      return;
    }
    if (!this.stable) {
      this.paused = true;
      this.onPause?.('A chest opened before a stable row reading was available. Add that chest manually, then resume.');
      return;
    }
    if (this.stable.capturedAt && capturedAt && new Date(capturedAt) - new Date(this.stable.capturedAt) > 15000) {
      this.paused = true;
      this.onPause?.('The last stable chest reading is too old. Check for missed openings, then reconnect.');
      return;
    }

    const event = { ...this.stable, badgeBefore: this.badge, badgeAfter: badge, occurredAt: capturedAt || new Date().toISOString(), ambiguous: this.candidate?.key !== this.stable.key };
    this.badge = badge;
    this.stable = null;
    this.candidate = null;
    this.pendingBadge = null;
    this.onEvent(event);
  }
}
