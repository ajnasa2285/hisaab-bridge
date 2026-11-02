// Which messages each agent accepts from the other side, the same in the one-process service
// (src/main.js) and in the separate services (src/service/config.js).

/** @typedef {import('./messages.js').MessageType} MessageType */

/** What a seller (the JCB agent or the supplier agent) accepts from the contractor's agent. @type {MessageType[]} */
export const TO_SELLER = ['BOOKING_REQUEST', 'ACCEPT', 'DISPUTE', 'PAYMENT_CLAIM', 'CANCEL', 'RECEIPT', 'REFUSE', 'EVIDENCE_REQUEST', 'EVIDENCE'];
/** @type {MessageType[]} */
export const TO_CONTRACTOR = ['BOOKING_REPLY', 'BILL', 'CORRECTION', 'SETTLED', 'PAYMENT_ACK', 'PAYMENT_RECEIVED', 'CANCEL', 'RECEIPT', 'REFUSE', 'EVIDENCE_REQUEST', 'EVIDENCE'];
/** Only the supplier delivers (material, with a challan). @type {MessageType[]} */
export const TO_CONTRACTOR_FROM_SUPPLIER = [...TO_CONTRACTOR, 'DELIVERY'];
/** Only the supplier is told the site's signed copy of its challan. @type {MessageType[]} */
export const TO_SUPPLIER = [...TO_SELLER, 'SITE_RECEIPT'];
