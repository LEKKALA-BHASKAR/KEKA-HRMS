/**
 * E-filing and tax-saving services shown on Manage Tax. Plain text cards
 * with outbound links — no logos and no claim of partnership. The official
 * Income Tax e-Filing portal comes first.
 */
export interface Provider { key: string; name: string; tagline?: string; url: string; action: string; points: string[] }

export const ITR_PROVIDERS: Provider[] = [
  {
    key: "itd", name: "Income Tax e-Filing", tagline: "Government of India portal", url: "https://www.incometax.gov.in/iec/foportal/", action: "File now",
    points: [
      "Log in with your PAN and verify with an OTP on your registered mobile.",
      "Salary, TDS and interest come pre-filled from Form 26AS and the AIS.",
      "Check the figures against the Form 16 you download from Forms.",
      "E-verify the return with an Aadhaar OTP — no paper needed.",
    ],
  },
  {
    key: "cleartax", name: "ClearTax", url: "https://cleartax.in/", action: "File now",
    points: ["Sign in with your PAN and verify with an OTP.", "Import pre-filled data in one step.", "Upload your Form 16.", "Review the computation and file."],
  },
  {
    key: "quicko", name: "Quicko", url: "https://quicko.com/", action: "File now",
    points: ["Upload the Form 16 you download from Forms.", "Bring in income, deductions and investments from the department's records.", "See how your tax is worked out before you e-file."],
  },
  {
    key: "taxspanner", name: "TaxSpanner", url: "https://www.taxspanner.com/", action: "File now",
    points: ["Sign in with your email and verify with an OTP.", "Prefill data in one step.", "Upload your Form 16.", "File your tax return."],
  },
];

export const TAX_SAVING_PROVIDERS: Provider[] = [
  {
    key: "cleartax", name: "ClearTax", url: "https://cleartax.in/save", action: "Invest & Save Tax",
    points: [
      "ELSS mutual funds qualify under section 80C with the shortest lock-in of the 80C options — three years.",
      "Invest online with KYC done digitally.",
      "Track your tax-saving investments in one place.",
    ],
  },
  {
    key: "taxspanner", name: "TaxSpanner", url: "https://www.taxspanner.com/", action: "Invest & Save Tax",
    points: [
      "Compare 80C, NPS (80CCD(1B)) and health-insurance (80D) options side by side.",
      "Plan investments against the room left in each section.",
      "Keep proofs together for your declaration.",
    ],
  },
];
