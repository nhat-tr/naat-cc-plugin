---
name: landing-page-review
description: Research-backed landing page review for pre-launch waitlist pages. Covers copy, SEO, design, competitive positioning, data protection trust, and legal safety. Verifies all claims before output. Use when reviewing a landing page or planning landing page improvements.
---

# Landing Page Review Skill

Evidence-based landing page review for pre-launch products. No assumptions — every claim verified before inclusion.

## When to Use

- User asks to review a landing page
- User asks for landing page improvement recommendations
- User asks about SEO, copy, conversion, or trust signals for a landing page
- User is planning a waitlist or pre-launch page

## Inputs Required

Before starting, gather from the user:

1. **Target market** — country, language, region
2. **Product positioning** — what is the product? (one sentence)
3. **Landing page purpose** — waitlist, launch, lead gen?
4. **Product stage** — pre-launch (no product), beta, live?
5. **Screenshot or URL** of the current page (if exists)

## Phase 1: Evidence Collection (Parallel)

Launch these research tasks in parallel using subagents. Do NOT proceed to analysis until all complete.

### 1.1 Read the Landing Page

- Read all landing page source files (components, translations, metadata, styles)
- Extract: every word of visible copy, meta title, meta description, structured data, heading hierarchy
- Note: what's present vs what's missing

### 1.2 Read Project Context

- Check memory for existing project context
- Read any design specs, product specs, competitive analysis docs the user references
- Extract: product positioning, competitive differentiation, target audience, feature list

### 1.3 Research Conversion Patterns

WebSearch for:
- `{industry} landing page conversion best practices {current_year}`
- `{industry} landing page trust signals conversion`
- `waitlist landing page optimization guide {current_year}`

Extract only data-backed claims: conversion lift percentages with sample sizes, A/B test results, documented before/after metrics. Discard opinions.

### 1.4 Research SEO Competition

For each keyword/query the landing page should target:
- WebSearch the exact query in the target language
- Document: who ranks, content depth, whether a new domain can realistically compete
- Rate each query: "genuinely underserved" / "moderate gap" / "hard to enter"

### 1.5 Verify All Financial/Legal/Domain Facts

If the landing page or FAQ contains factual claims (rates, laws, statistics):
- Search for the PRIMARY source (government sites, official publications, statute text)
- Verify each number is current for the target year
- Flag any number that comes from secondary sources (media, blogs) as unverified
- Record: exact figure, source, date of source, whether it's current

### 1.6 Verify Hosting & Deployment

- Check actual deployment configuration (Vercel, Netlify, Docker, CI/CD)
- Confirm: is the page actually deployed? Where?
- Do NOT claim hosting location without proof

### 1.7 Verify Structured Data Effectiveness

- Check current Google policies on structured data types being recommended
- Verify: does FAQPage/HowTo/etc. schema still produce rich results?
- Check if target site type (new domain, small business, etc.) is eligible

## Phase 2: Analysis

Only after all Phase 1 tasks complete.

### 2.1 Copy Audit

For each piece of copy (headline, subheadline, CTA, meta):
- Does it communicate what the product does?
- Does it name the target audience's problem?
- Does it differentiate from competitors?
- Is it outcome-focused or feature-focused?
- Rate: 1-10 with specific evidence for the rating

### 2.2 SEO Audit

- Meta title: contains target keywords? Under 60 chars?
- Meta description: contains keywords? Under 155 chars? Has call-to-action?
- Page content: word count, heading structure, keyword coverage
- Structured data: what exists, what's effective (not just valid)
- SERP competition: which queries are realistic targets?

### 2.3 Trust & Data Protection Audit (for apps handling user data)

Map user concerns to what's on the page:

| Concern | What users worry about | What's actually built | On the page? |
|---------|----------------------|----------------------|--------------|

Only claims that are TRUE TODAY or clearly framed as design intent are acceptable.

### 2.4 Legal Safety Audit (for pre-launch pages)

For every claim on the page or proposed for the page:

| Claim | Is the product live? | Present tense or future? | Verifiable? | Safe? |
|-------|---------------------|-------------------------|-------------|-------|

Rules:
- Pre-launch: NO present-tense capability claims ("macht X", "bietet X")
- Design commitments in future tense are acceptable ("wird X bieten", "wir entwickeln X")
- Factual information unrelated to the product is always safe
- Competitor comparisons must be factual, never defamatory
- No price or date commitments unless confirmed

### 2.5 Competitive Positioning Audit

- What does the product spec say is the differentiation?
- Is that differentiation visible on the landing page?
- Who are the actual competitors? What do their pages look like?
- What gap does this product fill? Is the gap communicated?

## Phase 3: Recommendations

### Structure

Organize into tiers:

**Tier 1 — Critical (before promoting the page):**
Only items that would actively hurt conversion or create legal risk if left unfixed.

**Tier 2 — High impact (before paid promotion):**
Items that significantly improve conversion or SEO but aren't blocking.

**Tier 3 — Long-term:**
SEO content strategy, structured data, social proof, supporting pages.

### Rules for Recommendations

- Every recommendation must cite its evidence basis
- If the evidence is from a different industry/context, say so
- Effort estimate: Low / Medium / High
- Never recommend FAQPage JSON-LD for "featured snippet eligibility" — verify current Google policy first
- Never recommend copy that claims unbuilt features exist
- All financial/legal facts in recommended copy must be verified against primary sources

## Phase 4: Self-Audit

Before delivering the review, audit every claim:

| Check | Method |
|-------|--------|
| Financial figures current? | Verified against primary source for target year |
| Legal claims safe? | No present-tense capabilities for unbuilt product |
| SEO claims realistic? | SERP competition actually checked, not assumed |
| Conversion data applicable? | Source context matches target context |
| Hosting/deployment claims verifiable? | Checked actual deployment config |
| Structured data recommendations valid? | Checked current Google policy |
| Competitor claims factual? | Based on actual SERP/product review, not assumptions |

If ANY cell fails, fix it before delivering. Flag remaining uncertainties explicitly.

## Output Format

Write results to `docs/reviews/{date}-landing-page-review.md` with:

1. Executive Summary (including product positioning)
2. What Works (table)
3. Copy Audit (per-element)
4. SEO Audit (meta + content + SERP competition)
5. Design & Layout Audit
6. Competitive Positioning
7. Data Protection / Trust Audit (if applicable)
8. Prioritized Recommendations (tiered)
9. Copy/Headline Alternatives (labeled as hypotheses)
10. FAQ Content (if recommended — with verified facts and legal-safe language)
11. SERP Competition Detail (verified)
12. Verification Log (what was checked, source, result)
13. Sources (all URLs, grouped by category)

## Critical Rules

1. **No assumptions.** Every factual claim must be verified. If you can't verify it, flag it as unverified.
2. **Pre-launch = no capability claims.** Only vision language for unbuilt features.
3. **Verify before recommending.** Don't recommend "add X to rank for Y" without checking if Y is achievable.
4. **Context matters.** Conversion data from a broker page doesn't automatically apply to a budget app waitlist. State the source context.
5. **Financial facts expire.** Always verify for the current year. Laws change. Rates change.
6. **User confirms positioning before analysis.** Don't assume what the product is — ask.
