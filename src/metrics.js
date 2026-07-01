// Day-1 operability kit (design decision 8A + OV-E delivery mechanism):
// in-memory counters exposed at /metrics in Prometheus text format, plus an
// in-app alert checker that POSTs to ALERT_WEBHOOK_URL — zero new infra, the
// system pages the operator instead of customers paging the operator.
//
// Counters are per-replica and operational (never billing — exact entitlement
// counters live in Postgres). Injectable clock/fetch so tests never sleep.

export function createMetrics({ now = Date.now } = {}) {
  const counters = {
    pack_pulls: 0,
    quota_denials: 0,
    claims_ok: 0,
    claims_fail: 0,
    degraded_activations: 0,
    search_path_scan: 0,
    search_path_fts: 0 // dormant until the 7A threshold switch activates
  };

  const state = {
    degradedSince: null, // ms timestamp when degraded mode last became active
    claimFailures: [], // ms timestamps of recent claim failures
    startedAt: now()
  };

  function inc(name, by = 1) {
    if (name in counters) counters[name] += by;
  }

  function setDegraded(active) {
    if (active && state.degradedSince === null) {
      state.degradedSince = now();
      counters.degraded_activations += 1;
    } else if (!active) {
      state.degradedSince = null;
    }
  }

  function recordClaimFailure() {
    counters.claims_fail += 1;
    state.claimFailures.push(now());
    // keep a 10-minute window
    const cutoff = now() - 10 * 60_000;
    state.claimFailures = state.claimFailures.filter((t) => t >= cutoff);
  }

  // Prometheus text exposition format, counters only — scrapable by anything,
  // readable by a human with curl.
  function render() {
    const lines = [
      '# TYPE basemouse_uptime_seconds gauge',
      `basemouse_uptime_seconds ${Math.floor((now() - state.startedAt) / 1000)}`
    ];
    for (const [name, value] of Object.entries(counters)) {
      lines.push(`# TYPE basemouse_${name} counter`, `basemouse_${name} ${value}`);
    }
    lines.push(
      '# TYPE basemouse_degraded gauge',
      `basemouse_degraded ${state.degradedSince === null ? 0 : 1}`
    );
    return lines.join('\n') + '\n';
  }

  return { counters, state, inc, setDegraded, recordClaimFailure, render };
}

// Evaluate alert conditions once. Returns the alerts that fired (also POSTed
// to webhookUrl when configured). Conditions per design decision 8A:
//   - degraded mode active for more than 5 minutes
//   - claim failures spiking (>=5 within 10 minutes)
// Each alert fires once per incident (refractory until the condition clears).
export async function runAlertChecks(metrics, {
  webhookUrl = process.env.ALERT_WEBHOOK_URL,
  fetchImpl = fetch,
  now = Date.now
} = {}) {
  const fired = [];
  const fl = metrics.state;
  fl.alerted = fl.alerted || {};

  const degradedFor = fl.degradedSince === null ? 0 : now() - fl.degradedSince;
  if (degradedFor > 5 * 60_000 && !fl.alerted.degraded) {
    fl.alerted.degraded = true;
    fired.push(`BaseMouse: degraded demo-fallback mode active for ${Math.round(degradedFor / 60_000)}m — the live store is unreachable.`);
  } else if (degradedFor === 0) {
    fl.alerted.degraded = false;
  }

  const recentFailures = fl.claimFailures.filter((t) => t >= now() - 10 * 60_000).length;
  if (recentFailures >= 5 && !fl.alerted.claims) {
    fl.alerted.claims = true;
    fired.push(`BaseMouse: ${recentFailures} key-claim failures in 10m — paying customers may be stuck on /claim.`);
  } else if (recentFailures === 0) {
    fl.alerted.claims = false;
  }

  if (webhookUrl && fired.length > 0) {
    for (const message of fired) {
      try {
        // Slack-style webhooks want JSON {text}; everything else (ntfy,
        // Discord-compatible relays) accepts a plain text body.
        const isSlack = webhookUrl.includes('hooks.slack.com');
        await fetchImpl(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': isSlack ? 'application/json' : 'text/plain' },
          body: isSlack ? JSON.stringify({ text: message }) : message
        });
      } catch (error) {
        // Alerting must never take the app down with it.
        console.error(`alert delivery failed: ${error.message}`);
      }
    }
  }
  return fired;
}
