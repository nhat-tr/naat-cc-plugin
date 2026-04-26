---
name: ubiquitous-language
description: Extract a glossary of domain terms from the current conversation, flagging ambiguities and proposing canonical names. Saves to UBIQUITOUS_LANGUAGE.md. Use when the user wants to define domain terms, build a glossary, harden terminology, or align on a ubiquitous language. Also trigger when the user mentions "domain model", "DDD", "we keep using X and Y interchangeably", "what should we call this?", "align on terminology", or when there's clear synonym/ambiguity confusion in the conversation.
disable-model-invocation: true
---

# Ubiquitous Language

Extract domain terminology from the current conversation into a glossary. This skill is about the **discipline** of grounded extraction — not a particular format. Pick a structure (tables, prose, or a mix) that fits the domain.

## Process

1. **Scan the full conversation** for domain-relevant nouns, verbs, and concepts.
2. **Identify problems**: synonyms (different words, same concept), ambiguities (same word, different concepts), vague or overloaded terms, and terms whose meaning drifted.
3. **Propose canonical names** for each concept. List the synonyms as aliases to avoid. When the choice isn't obvious, give a one-line reason.
4. **Write `UBIQUITOUS_LANGUAGE.md`** in the working directory. Whatever structure you pick, every canonical term must include: a definition, the aliases to avoid, and (where useful) how it relates to other terms.
5. **Summarize inline**: terms extracted, ambiguities flagged, what's still unsettled.

## Discipline (the rules — format is your call)

- **Never invent terms not in the conversation.** This is the single most important rule. If the conversation surfaced 4 domain terms, extract 4. Don't fill in plausible-sounding additions from your knowledge of the domain — a short accurate glossary is far more useful than a long fabricated one.

- **Define what the term IS, not what it does or how it's stored.** Three failure modes to avoid:
  - *Circular*: "An Order is when a customer orders something."
  - *Process*: "An Order is created when the customer submits the form."
  - *Implementation*: "An Order is a row in the orders table."
  Correct form: "An Order is a [what kind of thing] that [essential property distinguishing it]."

- **Pick canonical terms by domain expert vocabulary.** When synonyms compete, prefer what a non-technical domain expert would naturally say over engineering jargon. "Invoice" beats "PaymentRecord". "Practitioner" beats "ProviderEntity".

- **Flag ambiguities with a clear call.** State what was ambiguous, give the canonical recommendation, explain why the distinction matters operationally. Vague flags ("X might mean Y or Z") are useless — make a decision.

- **Skip non-domain terms.** Module names, class names, and technical infrastructure terms don't belong unless a domain expert would naturally reach for them in conversation.

## When conversation is thin

If there are fewer than ~5 meaningful domain terms, don't fabricate. Instead:
- Extract only what's actually there
- Add a note at the top of the file: _"This glossary is preliminary — invoke again after more domain discussion."_
- In the inline summary, name 2–3 specific things that, if discussed, would enrich the glossary (e.g., "Discussing how X moves through the system would unlock the lifecycle states.")

## Re-running

Read the existing `UBIQUITOUS_LANGUAGE.md` first. Add genuinely new terms. Update definitions only when the conversation has clarified them. Preserve stable terms even if they weren't mentioned recently — silence isn't deletion.
