# Bảo's rules

56 numbered rules that **Hồ Quốc Bảo** distilled from 10 years of running Meta ads for real clients. Workzone AI Ads applies them where they belong, and every optimisation suggestion in the app shows which rule produced it ("Bảo's rule #n"). The same list is in the app under **Bảo's rules** (`/playbook`), in Vietnamese and English.

Each rule is marked:

- **Enforced in code**: the system computes or blocks it itself.
- **AI instruction**: written into the AI prompts; the model is told to follow it, nothing checks the output.
- **Partly enforced**: part of the rule is in code; the note says what is not.

Totals: 41 enforced in code, 10 AI instructions, 5 partly enforced.

Thresholds are per-client settings where noted in code (for example the 90% / 80% confidence levels and the budget step); the values below are the defaults.

Contributions are welcome: propose a new rule or a change in an issue, ideally with the numbers that support it. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Customer persona

### 1. Don't target by product name. Ask who really needs it: how they live, what they do, what they care about.

*Why:* Competitors all pile onto the product name, so it is expensive.  
*Status:* AI instruction  
*Where:* `src/lib/ai/prompts.ts`

### 2. One direction per ad set: H1 "right need", H2 onwards "adjacent situation" (life circumstances competitors don't look at).

*Why:* Baby formula: H1 targets formula brands; H2 targets expecting mothers close to their due date.  
*Status:* AI instruction  
*Where:* `src/lib/ai/prompts.ts`

### 3. Rank evidence by trust: customers sales marked "Closed", then real customers, then high-scoring conversations; drop people sales rated junk.

*Why:* Never build a persona from a cheap engagement audience.  
*Status:* Enforced in code  
*Where:* `src/lib/audience.ts`, `src/lib/ai/prompts.ts`

### 4. Break the old-targeting loop: keep 30% of the top 20 for items never run before, and have the AI propose at least 8 expansion directions.

*Why:* The people messaging now were pulled in by the current targeting, so the persona drifts towards it.  
*Status:* Enforced in code  
*Where:* `src/lib/audience.ts`, `src/lib/ai/prompts.ts`

### 5. Watch out for "your customer's customers": the Spa interest means spa-goers; to reach owners, use the Page admin behaviours.

*Why:* A common trap when selling to shop owners.  
*Status:* AI instruction  
*Where:* `src/lib/ai/prompts.ts`

### 6. Rebuild the persona when there are 50 new conversations, 10 new sales ratings, a concluded hypothesis, a changed knowledge base, or after 30 days.

*Why:* An old persona skews every suggestion after it.  
*Status:* Enforced in code  
*Where:* `src/lib/freshness.ts`

## Targeting

### 7. The AI may only name interests; the system looks up the real ID, and drops and reports anything it can't find.

*Why:* Never let the AI invent targeting IDs.  
*Status:* Enforced in code  
*Where:* `src/lib/targeting-resolve.ts`

### 8. Validate every item on Meta by its real type (interest, employer, job title).

*Why:* A naive check wrongly rejects employers and job titles.  
*Status:* Enforced in code  
*Where:* `src/lib/targeting-validate.ts`

### 9. Meta still targets Vietnam's 63 old provinces: picking one new province means picking all the old provinces inside it.

*Why:* A Vietnam-specific trap after the merge into 34 provinces.  
*Status:* Enforced in code  
*Where:* `src/lib/vn-geo.ts`, `src/app/actions.ts`, `src/lib/ai/tasks.ts`

### 10. Targeting foreigners: don't use en_all (it reaches mostly Vietnamese); use ko, ja, zh_all or the Expats behaviour, age 22-45.

*Why:* A Vietnam-specific trap.  
*Status:* Enforced in code  
*Where:* `src/lib/foreign-targeting.ts`, `src/lib/plan-rules.ts`

### 24. Interest scores move from the AI's prediction to real numbers; "verified" from 20 results. A cheap ad set with over 50% junk leads is still WRONG.

*Why:* Real data weighs at most 75%, industry data at most 40%.  
*Status:* Enforced in code  
*Where:* `src/lib/audience.ts`, `prisma/schema.prisma`, `src/lib/planner-context.ts`

### 26. At least 10 interests in the same direction per ad set, joined with OR; if fewer, explain why instead of padding.

*Why:* Off-direction padding ruins the ad set.  
*Status:* Enforced in code  
*Where:* `src/lib/plan-rules.ts`, `src/lib/ai/prompts.ts`

### 27. Turn on Advantage+ audience on every ad set; never run a broad ad set as a direction. Exception: targeting foreigners.

*Why:* With it on, Meta expands to Vietnamese people.  
*Status:* Enforced in code  
*Where:* `src/lib/plan-rules.ts`, `src/lib/ai/prompts.ts`

### 56. Meta removed interest exclusions: to exclude people, exclude a custom audience (people who messaged, bought).

*Why:* To filter, use Narrow audience or change the content.  
*Status:* AI instruction  
*Where:* `src/lib/ai/prompts.ts`, `src/lib/plan-rules.ts`

## Content and campaign setup

### 18. Prefer EXISTING Page posts that already delivered cheap results, then high-engagement posts.

*Why:* A proven post is less risky than a new one.  
*Status:* Enforced in code  
*Where:* `src/lib/ai/context.ts`, `src/lib/ai/prompts.ts`

### 19. Never invent customer quotes, reviews, prices or offers; no countdowns like "only 3 days left".

*Why:* Ads run for many days, and making things up breaks the rules.  
*Status:* AI instruction  
*Where:* `src/lib/ai/prompts.ts`

### 28. Test 2-3 ad sets at about 2-3 × CPR per day each (at least 100,000 VND), ABO, one variable at a time.

*Why:* Only when one thing differs can you tell what won.  
*Status:* AI instruction  
*Where:* `src/lib/ai/prompts.ts`

### 29. Publish to Meta PAUSED, then re-check what was published.

*Why:* A person turns it on, not the machine.  
*Status:* Enforced in code  
*Where:* `src/lib/meta/graph.ts`

### 30. Small businesses need results in 1-2 days: never advise waiting 7 days, never run warm-up campaigns.

*Why:* Shop owners can't wait.  
*Status:* AI instruction  
*Where:* `src/lib/ai/prompts.ts`

### 54. Never ask about a flaw directly ("Do you have melasma?"); never promise medical effects; supplements must say "not a medicine"; weight loss, cosmetic and alcohol ads target 18+ only.

*Why:* Meta policy and Vietnamese advertising law.  
*Status:* AI instruction  
*Where:* `src/lib/ai/prompts.ts`, `src/lib/draft-policy-rules.ts`

### 55. Primary text 60-150 words, headline under 40 characters; messaging ads only need a hook + the problem + a call to action.

*Why:* Short but complete.  
*Status:* Partly enforced. Headlines over 40 characters get a warning; the word count is left to the AI.  
*Where:* `src/lib/ai/prompts.ts`, `src/lib/plan-rules.ts`

## Budget optimisation

### 20. Fatigue means: 7-day frequency above 3, 3-day CTR down more than 20%, AND CPM up no more than 15%.

*Why:* If CPM rose too, it's the auction, and swapping the ad won't fix it.  
*Status:* Enforced in code  
*Where:* `src/lib/optimize.ts`, `prisma/schema.prisma`

### 21. CTR holding while the result rate drops is a downstream problem: chat script, slow replies, the offer.

*Why:* Don't blame the ad.  
*Status:* AI instruction  
*Where:* `src/lib/ai/prompts.ts`

### 22. An age, gender or platform segment taking 15%+ of spend at 40%+ higher cost: duplicate the ad set without that segment.

*Why:* Advantage+ audience must be off on the copy.  
*Status:* Enforced in code  
*Where:* `src/lib/optimize.ts`

### 23. Sensible number of ad sets = budget ÷ (50 results/week × CPR ÷ 7). "Learning limited": merge ad sets, then widen the audience, and only then add money.

*Why:* Meta doesn't report learning status for messaging objectives.  
*Status:* Enforced in code  
*Where:* `src/lib/optimize.ts`, `src/lib/plan-rules.ts`

### 25. Auto target CPR = 90-day CPR (last 30 days counted double) × 0.9. A number you enter always wins.

*Why:* A target slightly better than today makes the expensive ad sets stand out.  
*Status:* Enforced in code  
*Where:* `src/lib/target-cpr.ts`, `src/lib/target-cpr-refresh.ts`, `prisma/schema.prisma`

### 31. Judge expensive vs. cheap by probability: pausing needs 90% confidence, scaling only 80%.

*Why:* A wrong increase is capped and can be undone.  
*Status:* Enforced in code  
*Where:* `prisma/schema.prisma`, `src/lib/optimize.ts`

### 32. Only raise a budget when the ad set spent 90% of it BEFORE 6pm.

*Why:* Spending it all by the end of the day is normal; running out early means there is room.  
*Status:* Partly enforced. Required for automatic increases. Raise-budget cards for manual approval are still created for every winning ad set.  
*Where:* `prisma/schema.prisma`, `src/lib/optimize.ts`, `src/lib/auto-rules.ts`

### 33. Each increase is +25%, at most ±30%, at least 24 hours apart; automatic increases require a budget cap.

*Why:* Avoids sending Meta back into learning.  
*Status:* Enforced in code  
*Where:* `prisma/schema.prisma`

### 34. Ad set with 0 results: suggest pausing after spending 2 × CPR (new ad sets 3 × CPR). Ad sets 20% over target get a warning, 40% a pause suggestion; single ads 50% over get a pause suggestion.

*Why:* That expensive after enough spend rarely fixes itself.  
*Status:* Enforced in code  
*Where:* `src/lib/optimize.ts`

### 35. Pause an ad whose good-lead rate is below 60% of the other ads (10+ leads on each side; good = rated good by sales or scored 50+ by the AI).

*Why:* Cheap but junk still costs money.  
*Status:* Enforced in code  
*Where:* `src/lib/optimize.ts`, `src/lib/lead-quality.ts`

### 36. Never pause the last ad set of a campaign or the last ad of an ad set.

*Why:* Stopping a whole campaign always needs a person.  
*Status:* Enforced in code  
*Where:* `src/lib/optimize.ts`

### 37. Every suggestion becomes a card waiting for approval; dismissed means not suggested again for 7 days, "Later" 3 days; if you turn something back on, it isn't suggested for pausing again for 3 days.

*Why:* The person running the ads always has the last word.  
*Status:* Enforced in code  
*Where:* `src/lib/optimize.ts`

### 38. Wait 3 days after any change on the same object.

*Why:* Give Meta time to react.  
*Status:* Enforced in code  
*Where:* `src/lib/optimize.ts`

### 39. Re-measure after 3 and 7 days; CPR down 5% or more counts as "better".

*Why:* Everything done gets graded.  
*Status:* Enforced in code  
*Where:* `src/lib/optimize.ts`

### 40. If more than half of the last 5 increases made things worse, lower the increase step by 10 points.

*Why:* The system corrects its own rules from real results.  
*Status:* Enforced in code  
*Where:* `src/lib/optimize.ts`

## Reading messages

### 11. Only label conversations that have been quiet for 3 hours.

*Why:* Reading mid-conversation scores it wrong and wastes AI spend.  
*Status:* Partly enforced. Applies in the "when the conversation goes quiet" mode. The default mode reads daily.  
*Where:* `src/lib/schedule.ts`, `src/lib/freshness.ts`, `src/lib/workflow.ts`

### 12. The AI must point out the Page's own service mistakes: slow replies, never asking for a phone number, not closing, wrong answers.

*Why:* Many customers are lost after the ad, not because of it.  
*Status:* AI instruction  
*Where:* `src/lib/ai/prompts.ts`, `src/lib/ai/schemas.ts`

### 13. Mask phone numbers, emails and account numbers before anything goes to the AI, without masking prices.

*Why:* Protect customer data.  
*Status:* Enforced in code  
*Where:* `src/lib/pii.ts`, `src/lib/ai/tasks.ts`, `src/lib/audience.ts`

## Passing leads to sales

### 14. Post leads to the sales Zalo group with the number masked; a salesperson presses "Claim" to see it, and the first to claim keeps the lead.

*Why:* Everyone knows who is handling whom.  
*Status:* Enforced in code  
*Where:* `src/lib/pii.ts`, `src/lib/lead-notify.ts`, `src/lib/lead-notify-config.ts`

### 15. A customer leaving their number a 2nd or 3rd time is still posted, marked "Nth time".

*Why:* Coming back means real interest.  
*Status:* Enforced in code  
*Where:* `src/lib/lead-notify.ts`

### 16. Unclaimed after 30 minutes: remind once, only 7am-9pm; no answer on the phone: remind to call back up to 3 times.

*Why:* Leads go cold fast.  
*Status:* Enforced in code  
*Where:* `src/lib/lead-confirm.ts`

### 17. Sales rate 4 columns: Contact · Quality · Outcome · Note. The sales rating OVERRIDES the AI score (closed 100, good 85, junk 5).

*Why:* Sales know the real customer better than the AI.  
*Status:* Enforced in code  
*Where:* `prisma/schema.prisma`, `src/lib/lead-quality.ts`

### 50. More than 5 leads in one run are merged into 1 message.

*Why:* Don't flood the sales group.  
*Status:* Enforced in code  
*Where:* `src/lib/lead-notify.ts`

### 51. Asking the bot "how many leads today?" answers in to-do order: unclaimed, claimed but not reported, didn't pick up.

*Why:* Sales see at once what to do first.  
*Status:* Enforced in code  
*Where:* `src/lib/lead-bot-report.ts`

### 52. An on-duty person per weekday, named in every lead notice and reminder.

*Why:* Nobody passes the buck.  
*Status:* Enforced in code  
*Where:* `src/lib/lead-notify-config.ts`, `src/lib/lead-notify.ts`

### 53. Recognise Vietnamese order comments ("chị 1 sét", "lấy 2") and post them to the sales group as a lead.

*Why:* Vietnamese customers often order right under the post.  
*Status:* Partly enforced. Order comments are recognised to measure in-store sales lift. They are not posted to the sales group yet.  
*Where:* `src/lib/sales-lift-calc.ts`, `src/lib/sales-lift.ts`

## Follow-ups

### 41. Follow up within 23 hours of the customer's last message (Meta allows 24; keep 1 hour spare).

*Why:* After 24 hours Meta blocks the message.  
*Status:* Enforced in code  
*Where:* `src/lib/nurture-rules.ts`, `src/lib/nurture.ts`

### 42. Don't send a follow-up while the customer is waiting for a real reply or is mid-conversation.

*Why:* An automatic message cutting in annoys people.  
*Status:* Enforced in code  
*Where:* `src/lib/nurture.ts`, `prisma/schema.prisma`

### 43. Don't resend a script sent in the last 7 days; if the customer says "stop", stop for good.

*Why:* Keeps the Page from being reported as spam.  
*Status:* Enforced in code  
*Where:* `src/lib/nurture.ts`

### 44. Past 24 hours, collect phone numbers into a custom audience for retargeting ads.

*Why:* If you can't message them, you can still reach them with ads.  
*Status:* Enforced in code  
*Where:* `src/lib/nurture.ts`

## Reports for the business owner

### 45. Report the cost per REAL customer: messages divided by people who left a number, lead forms divided by leads sales rated good.

*Why:* Owners pay for customers, not messages.  
*Status:* Enforced in code  
*Where:* `src/lib/client-daily-report.ts`, `src/components/daily-report-view.tsx`

### 46. Remind the client's own team: "X customers messaged without a reply, Y leads not called yet".

*Why:* Often the ads are fine and leads are dropped afterwards.  
*Status:* Enforced in code  
*Where:* `src/lib/client-daily-report.ts`, `src/components/daily-report-view.tsx`

### 47. Don't show the business owner the target cost or weak ad sets; show at most 5 good ones.

*Why:* The report reassures the owner; fixing is the ad runner's job.  
*Status:* Enforced in code  
*Where:* `src/lib/client-daily-report.ts`

### 48. Report notes are written by the machine from the numbers, no AI, at most 3 sentences; under 3% difference reads "in line with the weekly average".

*Why:* Never let the AI invent numbers.  
*Status:* Enforced in code  
*Where:* `src/lib/client-daily-report.ts`, `src/i18n/messages/vi/notify.ts`

### 49. Send reports only between 7am and 9pm; more than 60 minutes late, skip that day.

*Why:* A late report is worse than none.  
*Status:* Partly enforced. Skipping late reports is enforced. Scheduling outside 7am-9pm is not blocked yet.  
*Where:* `src/lib/report-schedule.ts`
