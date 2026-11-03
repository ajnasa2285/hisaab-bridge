// What a person reads in a message sent to the stand-in Graph API: a text's body, or a reply-button
// question's body with its buttons after it, as the text would have read ("सही है? हाँ / नहीं").

/** @param {any} body the JSON posted to /messages @returns {string | undefined} */
export function sentText(body) {
  if (body?.type === 'interactive') {
    const titles = (body.interactive?.action?.buttons ?? []).map((/** @type {any} */ b) => b.reply?.title);
    return `${body.interactive?.body?.text} ${titles.join(' / ')}`;
  }
  return body?.text?.body;
}
