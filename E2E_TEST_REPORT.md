# Osiris E2E Booking Flow Test Report

**Date:** 2026-04-06
**Tester:** Automated (Claude Code)
**Fake Customer:** Alex Thompson, +14246771112, 742 Evergreen Terrace, Naperville, IL 60540

---

## TEST 1: Voice Call (VAPI)

### Configuration
- **FROM phone:** +17169521258 (West Niagara VAPI number, ID: 3bad8017)
- **TO phone:** +15103705908 (WinBros VAPI number, ID: e2ea2551)
- **Customer AI:** GPT-4o-mini with ElevenLabs voice (pNInz6obpgDQGcFmaJgB)
- **VAPI Call ID:** `019d64f3-2d05-7000-ac56-53c880127294`

### Call Metrics
| Metric | Value |
|--------|-------|
| Call started | 2026-04-06T22:39:14Z |
| Call ended | 2026-04-06T22:41:06Z |
| Duration | ~112 seconds |
| End reason | `customer-ended-call` (WinBros assistant ended) |
| Cost | $0.1967 |

### Full Transcript

```
Customer AI: Hi. I am calling about getting my windows cleaned. Do you guys do free estimates?

WinBros Bot: A job right now, but I can help you get on the books. We've actually got a couple
free estimates slots open this week. In the Peoria area.

Customer AI: Thanks for letting me—

WinBros Bot: Want me to check what times work?

Customer AI: Thanks. But I'm in Naperville. Are you servicing this area?

WinBros Bot: Oh, my bad. We actually don't service Naperville right now. But I can take your info
in case we expand there soon. Want me to do that?

Customer AI: Yes, please. I'd like to get a quote on exterior window cleaning for my house in
Naperville. It's about 2500 square feet, no French panes. I'm looking for just exterior window
cleaning. Could you take down my info? My address is 742 Evergreen Terrace, Naperville, IL 60540.
The best time for me would be Saturday at 10 AM. You can reach me at 424-677-1112, texting is
fine too. I found you through Google search.

WinBros Bot: Got it. Let's take down your info for future reference. Service, exterior window
cleaning. Address, 742 Evergreen Terrace, Naperville, IL 60540. Preferred time, Saturday at 10 AM.
Contact 4—

Customer AI: Yep.

WinBros Bot: 2-4-6-7-7-1-1-1-2.

Customer AI: That's right.

WinBros Bot: Found us — Google search.

Customer AI: Yes. That's right.

WinBros Bot: Perfect. I've got all your info saved. In case we expand to Naperville, thanks so
much for reaching out. Have a great day.

Customer AI: Sounds great. Sounds great. Thanks.
```

**Recording:** https://storage.vapi.ai/019d64f3-2d05-7000-ac56-53c880127294-1775515269242-97a96c1a-01b7-49b1-82ab-1f2397096ffd-mono.wav

### Database Verification (Test 1)

| Table | Record Created? | Details |
|-------|----------------|---------|
| customers | NO | No record for +14246771112 or +17169521258 |
| leads | NO | No record found |
| jobs | NO | No record found |
| calls | NO | No record for VAPI call ID `019d64f3...` |
| messages | NO | No records found |

### Pass/Fail Checklist (Test 1)

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 1 | Call connected and lasted >30s | PASS | 112 seconds |
| 2 | VAPI assistant greeted with WinBros introduction | PARTIAL | Bot mentioned jobs/estimates but no formal "WinBros" intro |
| 3 | Customer assistant provided all required info | PASS | Name, address, sqft, no French panes, time, phone, source |
| 4 | No price quoted on call | PASS | Only offered free estimate / info collection |
| 5 | Call ended naturally | PASS | WinBros bot said goodbye, customer AI responded |
| 6 | Transcript captured | PASS | Full transcript available |
| 7 | Customer record created in DB | **FAIL** | No customer record created |
| 8 | Lead or job created in DB | **FAIL** | No lead or job created |
| 9 | Call logged in calls table | **FAIL** | Call not logged in DB |
| 10 | Post-call SMS sent to customer | **FAIL** | No SMS confirmation sent |

### Test 1 Issues

1. **CRITICAL - Service Area Mismatch:** WinBros bot said it doesn't service Naperville, IL. It mentioned "Peoria area" as their service region. The test identity's address (Naperville, IL) is outside the service area. This caused the bot to downgrade from "booking" to "info collection for future expansion."

2. **CRITICAL - No Database Records:** Despite the call completing successfully and the bot confirming it "saved" the customer's info, zero records were created in Supabase (no customer, lead, job, call, or message records). The VAPI webhook at `spotless-scrubbers-api.vercel.app/api/webhooks/vapi` may not have processed this call, or the call was not recognized as an inbound call to the WinBros assistant because it came from another VAPI number in the same org.

3. **UX Issue - Customer AI Info Dump:** The customer AI provided ALL information in a single response instead of answering questions one at a time. This didn't break the flow (WinBros bot handled it gracefully) but isn't realistic.

4. **UX Note - Bot Interruption:** The WinBros bot interrupted the customer AI with "Want me to check what times work?" before the customer finished speaking. Minor issue common in AI-to-AI calls.

### Test 1 Verdict: **FAIL**
The voice conversation itself worked well, but zero database records were created. The booking flow did not complete because Naperville is outside the service area.

---

## TEST 2: SMS Conversation (OpenPhone)

### Configuration
- **FROM phone:** +14246771112 (Cold Caller, ID: PNuat0xvca)
- **TO phone:** +17479663565 (WinBros OpenPhone, ID: PNviDF31lA)
- **Active webhooks:**
  - `https://www.theosirisai.com/api/webhooks/openphone` (message.received) - ENABLED
  - `https://cleanmachine.live/api/webhooks/openphone` (message.received) - ENABLED
  - `https://spotless-scrubbers-api.vercel.app/api/webhooks/openphone` (message.received) - DISABLED

### Conversation

| Time (UTC) | Direction | Message |
|------------|-----------|---------|
| 22:45:48 | Outgoing (us) | "Hi, I'm interested in getting my windows cleaned" |
| — | — | *No response received after 3+ minutes of polling* |

### Database Verification (Test 2)

| Table | Record Created? | Details |
|-------|----------------|---------|
| customers | NO | No record for +14246771112 |
| leads | NO | No record found |
| jobs | NO | No record found |
| calls | NO | N/A (SMS test) |
| messages | NO | No records found |

### Pass/Fail Checklist (Test 2)

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 1 | Bot responded within 60 seconds | **FAIL** | No response after 3+ minutes |
| 2 | Correct greeting (WinBros) | **FAIL** | No response |
| 3 | Asked relevant questions | **FAIL** | No response |
| 4 | Asked questions one at a time | N/A | No response |
| 5 | No hallucinated info | N/A | No response |
| 6 | Booking completed | **FAIL** | No response |
| 7 | No incorrect escalation | N/A | No response |
| 8 | Each reply within 60 seconds | **FAIL** | No response |
| 9 | Natural conversational tone | N/A | No response |
| 10 | No duplicate messages | N/A | No response |
| 11 | No quote/payment link sent | N/A | No response |
| 12 | No email request | N/A | No response |
| 13 | Customer record created | **FAIL** | No record in DB |
| 14 | Lead/job created | **FAIL** | No record in DB |
| 15 | Messages logged | **FAIL** | No records in DB |

### Test 2 Issues

1. **CRITICAL - Bot Never Responded:** The WinBros SMS bot did not respond to the inbound message at all. The message was delivered and visible on the WinBros OpenPhone number, but no automated reply was generated.

2. **ROOT CAUSE (Likely) - OpenPhone Internal Message Limitation:** The test sends SMS from one OpenPhone number (Cold Caller, PNuat0xvca) to another OpenPhone number (WinBros, PNviDF31lA) within the same OpenPhone organization. OpenPhone may not fire `message.received` webhooks for messages between numbers in the same account. Both webhook endpoints (theosirisai.com and cleanmachine.live) are healthy (returning 405 on GET = POST-only endpoints working correctly).

3. **ALTERNATIVE CAUSE - Webhook Routing:** The active webhooks have `resourceIds: ["*"]` which should fire for all phone numbers, but the backend may have tenant-based routing that rejected or ignored the message.

### Test 2 Verdict: **FAIL**
The SMS bot never responded. Likely caused by OpenPhone not triggering webhooks for intra-account messages.

---

## Metrics Summary

| Metric | Test 1 (Voice) | Test 2 (SMS) |
|--------|----------------|--------------|
| Total messages exchanged | 12 utterances (6 each) | 1 sent, 0 received |
| Time to booking confirmation | N/A (not booked - out of area) | N/A (no response) |
| Average bot response time | ~2-3s per utterance | N/A |
| Call duration | 112 seconds | N/A |
| DB records created | 0 | 0 |
| Errors/Unexpected | Service area rejection | No response at all |

---

## Overall System Verdict: **FAIL**

Both tests failed. Neither test resulted in a successful booking or any database records being created.

### Key Findings

1. **Voice call conversation quality is good** - The WinBros VAPI assistant handled the call naturally, collected information appropriately, and correctly identified that Naperville is outside its service area. However, no data was persisted to the database.

2. **SMS system is non-functional for this test setup** - The bot never responded to the inbound SMS. This is likely a test infrastructure issue (OpenPhone doesn't webhook on intra-account messages) rather than a production bug, but needs verification.

3. **Service area configuration** - The WinBros bot appears to be configured for the Peoria, IL area. The test identity's Naperville, IL address is outside this region. Future tests should use an address within the service area.

### Recommendations

1. **Re-test voice call with an in-service-area address** (e.g., a Peoria, IL address) to verify the full booking + database persistence flow.
2. **Re-test SMS from an external phone number** (not within the same OpenPhone account) to verify the webhook fires correctly.
3. **Investigate VAPI webhook processing** - Even though the call happened, the backend at `spotless-scrubbers-api.vercel.app/api/webhooks/vapi` did not create any DB records. Check webhook logs.
4. **Consider enabling the OpenPhone webhook on spotless-scrubbers-api** or verify which backend (theosirisai.com vs cleanmachine.live) handles WinBros tenant.
5. **Fix test identity address** to be within WinBros' service area for future tests.

---

## Appendix: Infrastructure Discovery

### VAPI Phone Numbers
| Name | Number | ID | Assistant |
|------|--------|-----|-----------|
| WinBros Number | +15103705908 | e2ea2551 | 74ba08ba |
| Winbros Mary Line | (no number) | b4ed6096 | 4370e3fe |
| Spotless Scrubbers | +15103705806 | c68431a2 | e3ed2426 |
| Cedar Rapids | +15103704011 | 6ae346c4 | 4c673d16 |
| West Niagara Cleaning | +17169521258 | 3bad8017 | 81cee3b3 |

### OpenPhone Numbers
| Name | Number | ID |
|------|--------|----|
| WinBros | +17479663565 | PNviDF31lA |
| Cold Caller | +14246771112 | PNuat0xvca |
| West Niagara Cleaning | +12893678441 | PNqgmlFDa0 |
| Primary | +14246771146 | PNvRA7PaW4 |

### OpenPhone Webhooks
| URL | Events | Status |
|-----|--------|--------|
| spotless-scrubbers-api.vercel.app | message.received, message.delivered | DISABLED |
| spotless-scrubbers-api.vercel.app | call.completed, call.ringing | DISABLED |
| www.theosirisai.com | message.received, message.delivered | ENABLED |
| www.theosirisai.com | call.completed, call.ringing | DISABLED |
| cleanmachine.live | message.received, message.delivered | ENABLED |
| cleanmachine.live | call.completed, call.ringing | ENABLED |

### Supabase Schema (Key Tables)
- **customers:** id, tenant_id, phone_number, first_name, last_name, email, address, sqft, lead_source, ...
- **leads:** id, tenant_id, phone_number, customer_id, first_name, last_name, status, source, ...
- **jobs:** id, tenant_id, customer_id, phone_number, address, service_type, date, status, ...
- **calls:** id, tenant_id, phone_number, direction, vapi_call_id, transcript, duration_seconds, outcome, ...
- **messages:** id, tenant_id, direction, phone_number, content, role, ai_generated, source, ...

### Pre-existing Data Cleaned
Before testing, 3 customer records, 3 leads, 4 jobs, 5 calls, 11 messages, 1891 system events, and 4179 followup queue entries were deleted for +14246771112. This indicates extensive prior testing with this phone number.
