// Reading people.json (its shape: the top of src/main.js): names of lines and agents become their ids.

/**
 * @param {unknown} raw the parsed file
 * @param {Record<string, string>} lineIds line name to phone_number_id
 * @param {Record<string, string>} agentIds 'jcb' | 'contractor' | 'supplier' to agent id
 */
export function parsePeople(raw, lineIds, agentIds) {
  if (!Array.isArray(raw)) throw new Error('config: people.json must be a list');
  return raw.map((p, i) => {
    const lineId = Object.hasOwn(lineIds, p?.line) ? lineIds[p.line] : undefined;
    const agent = agentIds[p?.agent];
    if (!lineId || !agent) throw new Error(`config: people.json entry ${i + 1} needs line ${Object.keys(lineIds).map((n) => `'${n}'`).join('|')} and agent 'jcb'|'contractor'|'supplier'`);
    // The supplier agent has one role, and that role belongs to no other agent.
    if ((p.agent === 'supplier') !== (p.role === 'supplier')) throw new Error(`config: people.json entry ${i + 1}: role 'supplier' goes with agent 'supplier' and only with it`);
    // Optional: the site this person usually works on; a request that names no site is for it.
    const site = p.site === undefined || p.site === null ? undefined : String(p.site).trim();
    if (site !== undefined && (!site || site.length > 80)) throw new Error(`config: people.json entry ${i + 1}: site must be a name of 1 to 80 characters`);
    return { line: lineId, phone: String(p.phone), agent, role: p.role, name: String(p.name ?? ''), ...(site ? { site } : {}) };
  });
}
