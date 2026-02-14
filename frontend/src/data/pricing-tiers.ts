export const PAYMENT_FREQUENCIES = ["monthly", "yearly"]

export const TIERS = [
  {
    id: "free",
    name: "Free",
    price: {
      monthly: 0,
      yearly: 0,
    },
    description: "Smart AI tools with limits",
    features: [
      "Automated listing generation (limited)",
      "Full suite of product images per listing (limited)",
    ],
    cta: "Get Started",
  },
  {
    id: "plus",
    name: "Plus",
    price: {
      monthly: 179,
      yearly: 134,
    },
    description: "AI-native automation",
    features: [
      "Automated listing generation",
      "Full suite of product images per listing",
      // "Amazon search algorithm–based optimization",
      "Priority email & chat support",
    ],
    cta: "Get Started",
    popular: true,
  },
  {
    id: "pro",
    name: "Pro",
    price: {
      monthly: 199,
      yearly: 149,
    },
    description: "AI-native automation",
    features: [
      "Automated listing generation",
      "Full suite of product images per listing",
      // "Amazon search algorithm–based optimization",
      "Priority email & chat support",
      "AI Product Swapping",
      "AI Outfit Replacement",
      "AI Product Videos (limited)",
    ],
    cta: "Get Started",
  },
  {
    id: "business",
    name: "Business",
    price: {
      monthly: "Contact sales",
      yearly: "Contact sales",
    },
    description: "AI-native automation",
    features: [
      "Private deployment option",
      "Unlimited usage with all Pro features included",
      "Discounted LLM API support",
      "Ongoing feature updates",
      "AI NATIVE automated ad (coming soon)",



      // "Custom AI model tuning",
      // "Onboarding & training",
      // "SLAs & dedicated support",
      // "Data-driven AI NATIVE ads automation",
    ],
    cta: "Contact us",
    highlighted: true,
  },
]
