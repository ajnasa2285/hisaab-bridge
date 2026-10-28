// Who is who: each person is known on one WhatsApp line (the receiving phone_number_id) and
// belongs to one agent in one role. The same phone can be known on both lines (a contractor
// who also messages the JCB number), but only once per line. Anyone else is unknown.

export const ROLES = /** @type {const} */ (['jcb_owner', 'operator', 'contractor', 'supervisor', 'supplier']);

/** @typedef {typeof ROLES[number]} Role */
/** A person; `site` (optional, people.json) is where they usually work. @typedef {{line: string, phone: string, agent: string, role: Role, name: string, site?: string}} Person */

/**
 * @param {{lines: string[], people: Person[]}} config lines are phone_number_ids
 */
export function createDirectory(config) {
  const lines = new Set(config.lines);
  /** @type {Map<string, Person>} */
  const byKey = new Map();
  for (const p of config.people) {
    if (!lines.has(p.line)) throw new Error(`directory: unknown line for ${p.name}`);
    if (!/^\d{6,15}$/.test(p.phone)) throw new Error(`directory: phone for ${p.name} must be digits with country code`);
    if (!ROLES.includes(p.role)) throw new Error(`directory: unknown role ${p.role}`);
    if (!/^agent:[a-z0-9][a-z0-9._-]{0,63}$/.test(p.agent)) throw new Error(`directory: bad agent id ${p.agent}`);
    const key = `${p.line}|${p.phone}`;
    if (byKey.has(key)) throw new Error(`directory: a phone is listed twice on one line`);
    byKey.set(key, { ...p });
  }

  return {
    /** @param {string} line */
    hasLine: (line) => lines.has(line),
    /**
     * @param {string} line the receiving phone_number_id
     * @param {string} phone the sender
     * @returns {Person | null}
     */
    route(line, phone) {
      const p = byKey.get(`${line}|${phone}`);
      return p ? { ...p } : null;
    },
    /**
     * Everyone with this role in this agent (e.g. to tell the JCB owner about a dispute).
     * @param {string} agent
     * @param {Role} role
     * @returns {Person[]}
     */
    people(agent, role) {
      return [...byKey.values()].filter((p) => p.agent === agent && p.role === role).map((p) => ({ ...p }));
    },
  };
}
