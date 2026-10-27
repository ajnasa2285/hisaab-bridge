# Hisaab Bridge

**Evidence ledger → the owner's भेजो → signed A2A bill → accept or dispute → Muse Spark explains only code-checked differences → payment confirmed → settled on both sides.**

An evidence-backed ledger between small businesses on WhatsApp: a contractor and his suppliers (a JCB owner, a sand/cement supplier) agree on hours, deliveries and payments. Built on Meta's Muse models for the Meta Global AI Developer Hackathon (Startup track, Build for Your World).

**Status:** work in progress, built during the event (27 October to 4 November 2026).

## The problem

A contractor hires a JCB and buys sand and cement. Each supplier keeps his own count of hours and bags; the contractor's supervisor keeps another. At month end the counts and the payments do not match, and the argument costs everyone time, money and trust.

## How it works

1. **Booking.** The supervisor asks his contractor's agent for a JCB or material. The contractor approves; his agent asks the supplier's agent; the supplier says yes, no, or another time.
2. **Evidence.** The JCB operator sends hour-meter photos; the supplier's delivery comes with a challan photo and the supervisor's confirmation of what arrived. Muse Spark reads the printed digits; code checks continuity, limits and quantities.
3. **Signed bill.** After the supplier's owner says भेजो, his agent sends a bill signed with Ed25519, with its evidence, over A2A. The contractor's agent returns a signed receipt.
4. **Accept or dispute.** The contractor accepts, or disputes with his own figure. Muse Spark explains every difference to both sides in plain Hindi; code checks every figure it cites. The supplier keeps his bill or sends a correction. Nothing is rewritten.
5. **Payment and settlement.** The contractor sends his UPI screenshot; Muse Spark reads it and code matches it with the bill. The ledger is settled on both sides only when the supplier confirms the money arrived.

Nothing is booked, sent, accepted, corrected or settled without the explicit WhatsApp reply of the person allowed to decide it.

## Models

Every model called at runtime is a Meta model, through the Meta Model API: **Muse Spark** (understanding messages, reading meters, challans and UPI screenshots, explaining differences) and **Muse Voice Transcribe** (Hindi voice notes).

## Disclosure

All code in this repository was written during the event. The design draws on what the author learned running private pilots of WhatsApp agents for his own businesses: a brick-kiln bookkeeping agent in production since October 2026, a JCB hours agent and a contractor site-office agent. No code from them is used. The organisers confirmed that mentioning the existing pilot as context is fine since no prior code is used.

Pilot users: a JCB owner and a contractor we work with (with their consent). All data in this repository is invented; real photos and payments never leave the private server.

Coding tools used: Claude Code (lead), Astra, Fable, Codex, Muse Code.

## Licence

Apache License 2.0.
