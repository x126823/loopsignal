import { goldenCase as c } from "../types";

/** Intent classifier golden set. expected.actionable: should this message be tracked until closed? */
export const INTENT_CASES = [
  // Actionable
  c("intent-outage", { actionable: true }, [["in", "Hi, our checkout page returns an error for every customer right now. Can you look into this urgently?"]]),
  c("intent-invoice-copy", { actionable: true }, [["in", "Could you send me a copy of last month's invoice?"]]),
  c("intent-login", { actionable: true }, [["in", "I can't log in since this morning and the password reset does not work."]]),
  c("intent-pricing-question", { actionable: true }, [["in", "Quick question: does the Pro plan include API access?"]]),
  c("intent-follow-up", { actionable: true }, [["out", "We will look into it."], ["in", "Following up on my request from Monday, I still have no response."]]),
  c("intent-address", { actionable: true }, [["in", "Please update our billing address to 12 Example Street."]]),
  c("intent-export", { actionable: true }, [["in", "The CSV export is missing the region column again. Please fix this."]]),
  c("intent-seats", { actionable: true }, [["in", "We need two more seats added to our account before Friday."]]),
  c("intent-blocked", { actionable: true }, [["in", "Is there a workaround for the upload timeout? We are blocked until it is sorted."]]),
  c("intent-double-charge", { actionable: true }, [["in", "The invoice total looks wrong, we were charged twice this month."]]),
  c("intent-sso", { actionable: true }, [["in", "I need help configuring SSO for our new tenant."]]),
  c("intent-callback", { actionable: true }, [["in", "Can someone call me about the contract renewal?"]]),
  c("intent-low-priority", { actionable: true }, [["in", "Not urgent, but could you add a dark mode option at some point in the future?"]]),
  c("intent-thanks-plus-request", { actionable: true }, [["in", "Thanks! One more thing: could you also resend the invoice for September?"]], { note: "gratitude must not hide a request" }),
  c("intent-french", { actionable: true }, [["in", "Bonjour, pouvez-vous réinitialiser mon accès s'il vous plaît ? Merci."]], { note: "non-English request" }),
  // Not actionable
  c("intent-thanks", { actionable: false }, [["in", "Thanks so much, that fixed it!"]]),
  c("intent-ooo", { actionable: false }, [["in", "I am out of office until Monday. This is an automatic reply and I will respond when I return."]]),
  c("intent-newsletter", { actionable: false }, [["in", "This week in product: three new templates and a refreshed editor. Unsubscribe at any time."]]),
  c("intent-receipt", { actionable: false }, [["in", "Your payment of $49.00 was received. Receipt #1234. No further action is required."]]),
  c("intent-fyi", { actionable: false }, [["in", "FYI the maintenance window has moved to Sunday night. No action needed on your side."]]),
  c("intent-our-ack", { actionable: false }, [["in", "Please look at my invoice."], ["out", "Thanks, we have received your request and will look into it."]], { note: "our own acknowledgment is never actionable" }),
  c("intent-our-answer", { actionable: false }, [["in", "Where is my refund?"], ["out", "I checked and the refund was issued yesterday."]], { note: "our own substantive reply is never actionable" }),
  c("intent-praise", { actionable: false }, [["in", "Great webinar yesterday, thanks for hosting."]]),
  c("intent-shipping", { actionable: false }, [["in", "Delivery status update: your package has shipped and will arrive Thursday."]]),
  c("intent-holiday", { actionable: false }, [["in", "Happy holidays from all of us at Acme Corp!"]]),
  c("intent-internal-chat", { actionable: false }, [["int", "Lunch at noon? Bring the team."]]),
  c("intent-spam", { actionable: false }, [["in", "You have won a prize! Click here to claim your reward today."]]),
  c("intent-sounds-good", { actionable: false }, [["in", "Sounds good, talk soon."]]),
  c("intent-ambiguous-fyi-question", { actionable: false }, [["in", "Just so you know, I changed my phone number. No reply needed."]], { note: "contains no request despite being about the account" }),
];
