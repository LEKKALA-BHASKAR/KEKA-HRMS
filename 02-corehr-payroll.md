# Keka HR — CORE HR & PAYROLL: Exhaustive Feature Research

**Research date:** 18 September 2026
**Primary source:** Keka's own admin help centre (`help.keka.com`), which exists in two parallel URL schemes:
- Newer Zendesk-style: `https://help.keka.com/hc/en-us/articles/<id>-<slug>`
- Legacy slug-style: `https://help.keka.com/admin/<slug>` (and `https://help.keka.com/admin/knowledge/<slug>`, `https://help.keka.com/admin/admin-help/<slug>`)
- Older Freshdesk archive: `https://support.keka.com/support/solutions/articles/<id>-<slug>` (mostly superseded; robots-blocked to automated fetch)

**Evidence convention used throughout this document:**
- **[DOC]** = stated in Keka's own product documentation / help centre / official site.
- **[REVIEW]** = claimed by third-party reviewers (G2, Capterra, SoftwareSuggest etc.), NOT confirmed by Keka docs.
- **[UNCERTAIN]** = inferred, partially documented, or could not be confirmed. Treat as a question to verify.

**Access note:** direct shell/curl to keka.com was blocked by network policy for this research; everything below came from WebSearch + WebFetch. A handful of Keka pages return `ROBOTS_DISALLOWED` to automated fetchers (notably parts of `www.keka.com` and some `/admin/` slugs), so those are marked where relevant.

---

# PART A — CORE HR / "MODERN HR"

## A0. Where Core HR lives in the help centre

Admin Help Center → **Core HR** section: `https://help.keka.com/hc/en-us/sections/39010982224913-Core-HR`

Core HR is divided into these documented sub-sections **[DOC]**:

| Sub-section | Contents |
|---|---|
| Organization & Employees | Org structure, legal entities, business units, departments, locations, cost centres, bands, pay grades, worker types, employee profiles, invites, visibility, ID cards, announcements, polls, surveys, org dashboard |
| Onboarding and Probation | Onboarding overview, onboarding tasks & task lists, onboarding groups, initiating onboarding, probation policies |
| Preboarding | Preboarding overview, candidate experience portal, offer templates, task templates, dependent tasks, new joiners section |
| Background Verification | Ongrid integration, SpringVerify integration, initiating/tracking BGV |
| Employee Exits | Notice period settings, exit reasons, exit tasks & lists, initiating exits, bulk exits, tracking exits, retaining an employee, F&F settlement, exit survey |
| Roles & Privileges | Roles & permissions overview, implicit roles, user roles |
| Documents | Employee documents, document templates, document workflows, org documents, acknowledgement enforcement, field/folder settings |
| Assets | Asset categories & types, adding assets, assigning, requesting, conditions, acknowledgement, ID series, reports, marking unavailable |
| Analytics & Reports | Growth/exits/retention analytics, employee demographics analytics, attrition tracking |
| Apps & Integrations | SSO (Okta, Azure AD, JumpCloud, OneLogin), calendar integration |
| Notifications | Email notifications, Slack notifications & webhooks, event triggers, webhooks |
| US onboarding | (US-specific onboarding) |
| Core HRMS FAQs | 70+ FAQ articles (sub-grouped: Organization & Employees, Onboarding and Probation, Assets, Preboarding, Exits, Email & Notifications, Documents, Apps & Integrations, Analytics & Reports, Roles & Privileges, Kiosk) |

---

## A1. Organisation structure

**Source:** `https://help.keka.com/admin/setting-up-the-organizational-structure`

Keka's documented org hierarchy **[DOC]**:

1. **Legal Entity** — "different companies or subsidiaries that make up an organization". This is the top-level container and is what statutory registrations (PAN/TAN, PF, ESI, PT, LWF) attach to.
2. **Business Unit** — "different divisions or departments within each legal entity".
3. **Location** — "physical locations where your organization operates". Locations drive **Professional Tax** and **LWF** state rules (see Payroll section).
4. **Department** — "different functional areas within each business unit".

Additional org objects, each with its own dedicated help article **[DOC]**:

- **Cost centres** — "Adding and modifying cost centres"
- **Bands** — "Adding and modifying Bands" (career bands / levels)
- **Pay Grades** — "Adding and editing Pay Grades" (used by payroll + compensation analytics)
- **Worker Types** — "Creating & Managing Worker Types"; separate article for **Managing Contract Workers**
- **Job titles** — set per employee, with **effective-dating** on change (documented under employee profile: "The system allows you to set effective dates when updating employee positions, particularly useful during promotions or departmental transfers") **[DOC]**
- **Org Dashboard** — "Org Dashboard Overview"

Setup path **[DOC]**: Keka Portal → Setup → add legal entity → create business unit(s) → add location details → departments.

**[UNCERTAIN]** The org-structure overview article does not itself document the **org chart** visualisation, **secondary/dotted-line reporting managers**, or field-level definitions for each object. A dedicated org-chart article was not located in the Core HR index. Keka's marketing pages reference an org chart, and reviewers mention it, but I could not confirm a help article describing dotted-line/secondary managers. **Flag for verification.**

### Employee ID / employee number
- "How to edit employee number on Keka?" — `https://help.keka.com/hc/en-us/articles/39946559886737-How-to-edit-employee-number-on-Keka` **[DOC]** — employee numbers are editable.
- **[UNCERTAIN]** A documented auto-generating **employee ID series/prefix scheme** for employees was not located. Note that Keka *does* document an **Asset ID Series** ("Managing Asset ID Series") and **ID Card settings** ("Managing ID Card Settings in Keka", `https://help.keka.com/hc/en-us/articles/39946699709329-Managing-ID-Card-Settings-in-Keka`) — do not confuse these with an employee-number series. Flag for verification.

---

## A2. Employee database & profile

**Source:** `https://help.keka.com/admin/managing-employee-profiles-on-keka-hr`
(Zendesk mirror: `https://help.keka.com/hc/en-us/articles/39946786383889-Managing-Employee-Profiles-on-Keka-HR`)

### Profile tabs **[DOC]**
`About` · `Profile` · `Job` · `Time` · `Documents` · `Assets` · `Finances` · `Expenses` · `Performance`

### Cards inside the Profile tab **[DOC]**
- Primary Details
- Contact Information
- Addresses
- Experience
- Education
- Identity Information

### Documented profile capabilities **[DOC]**
- **Profile completion tracking** — "If any details are missing, you will see a notification indicating the percentage of profile completion", plus flagging of mandatory fields.
- **Identity documents** — upload PAN Card, Aadhaar Card, Voter ID, Driving Licence, Passport.
- **Effective-dated job title changes** — set an effective date when updating position (promotions, departmental transfers).
- **Field Permissions** — admins control field visibility and edit rights per field.
- **Card customisation** — profile cards can be re-ordered via Admin Tools.
- **Employee Visibility Settings** — separate article "Managing Employee Visibility Settings".

### Custom fields **[DOC]**
- "How to edit/delete a custom field for employee profile?" — `https://help.keka.com/hc/en-us/articles/39946618229777-How-to-edit-delete-a-custom-field-for-employee-profile`
- "How to make employee custom fields mandatory?" — `https://help.keka.com/admin/admin-help/how-to-make-employee-custom-fields-mandatory`
- "How to add Employee Custom Fields?" (Freshdesk archive) — `https://keka.freshdesk.com/support/solutions/articles/84000383164-how-to-add-employee-custom-fields-`
- Separate custom-field systems exist for **Keka Hire** ("How to add custom fields in Keka Hire?") and for **clients/projects in PSA** ("Adding and managing client and project custom fields") — these are distinct from employee custom fields.
- **Profile Field Tasks** — custom profile fields can be turned into onboarding tasks: "Create and manage Profile Field Task Templates" / "Introducing Profile Field Tasks in Keka Task Templates".

### Adding employees **[DOC]**
**Source:** `https://help.keka.com/admin/adding-a-new-employee` / `https://help.keka.com/hc/en-us/articles/39946620557969-Adding-a-new-employee`

Add-employee wizard steps and fields:
1. **Basic Details** — First Name, Last Name, Phone Number, Email
2. **Job Details** — Job Title, Joining Date, Reporting Manager, Legal Entity, Business Unit
3. **Work Details** — invite employee to log in; assign **Onboarding Flow**; Time & Attendance (Leave Plan, Shift, Weekly Off); **Expense Policies**; **Overtime Policies**; Attendance Number
4. **Compensation (optional)** — Pay Group, Annual Salary, Payroll Settings, Salary Structure

**Bulk operations documented [DOC]:**
- Bulk add employees via Excel template (required fields highlighted in red)
- "Editing or adding employee job details in bulk"
- "Bulk importing Employee Documents"
- "Invite Employees to Keka"
- "Updating employee details in Keka" — `https://help.keka.com/hc/en-us/articles/39946629892881-Updating-employee-details-in-Keka`

**[UNCERTAIN]** The add-employee article does not document secondary / dotted-line manager fields or an employee-ID scheme. Flag for verification.

---

## A3. Employee number (employee ID) series

**Source:** `https://help.keka.com/hc/en-us/articles/39946565641745-How-to-setup-an-employee-number-series-on-Keka`
(legacy: `https://help.keka.com/admin/knowledge/how-to-setup-an-employee-number-series-on-keka`)

**[DOC]** Confirmed: Keka has a configurable employee-number series.

- Path: **Org → Employees → Settings → Employee Number**
- Configurable fields: **Name, Description, Prefix, Digits in Number, Suffix, Next Number**, Active/Inactive status
- Once active, "The new employee numbers will now be automatically generated. You can manually add numbers if necessary."
- **Multiple series supported** — "+Add New Series" creates additional numbering schemes beyond the default (useful for separate entities/worker types).
- Employee numbers can be edited after assignment ("How to edit employee number on Keka?").

**[UNCERTAIN]** The documentation does not explicitly state whether a series can be scoped per legal entity / worker type, only that multiple series can exist. Flag for verification.

Screenshots in that article:
- `https://help.keka.com/hc/article_attachments/40643329060625`
- `https://help.keka.com/hc/article_attachments/40643345645329`
- `https://help.keka.com/hc/article_attachments/40643345649809`
- `https://help.keka.com/hc/article_attachments/40643345651089`

---

## A4. Employee lifecycle

### A4.1 Preboarding (pre-joining portal)

**Source:** `https://help.keka.com/hc/en-us/articles/39946667555857-Preboarding-Overview`

**[DOC]** Keka's preboarding is a distinct stage that runs **before** the employee record is fully created. Documented capabilities:

- **Preboarding flow is non-linear** — organisations can initiate "document collection, offer letter acceptance, and even employee creation" in any sequence.
- **Candidate Experience Portal** (the pre-joining portal) — candidates can:
  - "view and accept offer letters"
  - "complete assigned tasks"
  - "receive welcome messages and content tailored to your brand"
  - Article: "Managing the Candidate Experience Portal on Keka" (`https://help.keka.com/admin/managing-the-candidate-experience-portal-on-keka`)
- **Offer letters & Offer Templates** — `https://help.keka.com/hc/en-us/articles/39946726416529-Creating-Offer-Templates`. Offer-letter approval can be enabled/edited ("How to enable/edit offer letter approval").
- **Document collection** built into preboarding; "Candidate submission status verification during preboarding collection" and "Preboarding document request modifications" are documented FAQs.
- **Task Templates** — replaced the older "Task Lists" and "Onboarding Groups" concepts. "Tasks can be automatically triggered based on: **Department, Location, Worker type**."
  - `https://help.keka.com/hc/en-us/articles/39946720114449-Setting-up-Task-Templates-on-Keka`
  - **Profile Field Tasks** — tasks that collect specific profile fields: `https://help.keka.com/hc/en-us/articles/39946715858065-Create-and-manage-Profile-Field-Task-Templates`
  - **Dependent Tasks** — task A gates task B: `https://help.keka.com/hc/en-us/articles/39946745738129-Dependent-Tasks-in-Keka-Task-Templates`
  - "Task Template Migration" article exists for customers moving off the old model.
- **Dashboards**:
  - **New Joiners Dashboard** — "track upcoming joiners in real time", plan Day-1 activities, allocate resources
  - **Onboarding Tasks Dashboard** — "a candidate-centric view of progress", status monitoring, delay detection

### A4.2 Onboarding

**Source:** `https://help.keka.com/hc/en-us/articles/39946653303441-Initiating-Onboarding-for-Employees`

**[DOC]**
- Path: **Org → Onboarding tasks** tab → list of employees not yet onboarded.
- Onboarding "automatically takes care of key operational tasks such as **collecting documents, assigning assets**" and notifies stakeholders of their responsibilities.
- **Bulk onboarding** via checkboxes — with the caution "Only select employees who belong to the same onboarding group to ensure consistent workflows."
- **Skip Onboarding** — exclude existing employees; they are marked "Onboarding Skipped".
- **Onboarding Groups** determine which task set an employee receives (legacy model; superseded by Task Templates in the preboarding-era design).
- Other articles: "Creating Onboarding Tasks and Task Lists", "Creating and Managing Onboarding Groups", "Tracking and Managing the Onboarding Process", "Overview - Employee Onboarding".
- A **US onboarding** sub-section exists separately in Core HR.

Screenshots: `https://help.keka.com/hc/article_attachments/40247577515537`, `.../40247577518865`, `.../40247561334033`; plus a Vimeo walkthrough (`player.vimeo.com/video/933680213`).

### A4.3 Background verification (BGV)

**[DOC]** BGV is a first-class Core HR sub-section with vendor integrations:
- **Ongrid** — `https://help.keka.com/hc/en-us/articles/39946713812881-Ongrid-Integration-with-Keka` / `https://help.keka.com/admin/integrating-ongrid-with-keka`
- **SpringVerify** — `https://help.keka.com/admin/integrating-springverify-with-keka-2`
- **Custom BGV vendors** — `https://help.keka.com/hc/en-us/articles/39946693819537-Adding-and-Managing-Custom-BGV-Vendors-in-Keka`
- **Partner API** — `https://developers.keka.com/docs/background-verification-partners-guide` (any BGV vendor can build an integration)
- BGV can be run for **preboarding candidates** as well as employees — `https://help.keka.com/admin/background-verification-through-keka-hr`
- Marketplace also lists **cFIRST BGV, InstaVeritas, HelloVerify BGV, Checkr** (US).
- Tracking article: "Tracking & Initiating Background Verification" (`https://help.keka.com/admin/tracking-initiating-background-verification-1`)

### A4.4 Probation & confirmation

**Source:** `https://help.keka.com/admin/configuring-and-managing-probation-policies`

**[DOC]** Probation policies are assignable to employee groups. Configurable:
- **Basic**: policy name, description, **duration**, and "maximum number of times the probation period can be extended for an employee"
- **Advanced (mutually exclusive)**:
  1. *Evaluation trigger* — "This will trigger an automatic evaluation before the probation ends."
  2. *Auto-completion* — "This will end the probation period for any employee automatically once the time period ends"
- **Evaluation / review workflow** when evaluations are on:
  - Multi-level feedback with customisable evaluators (**specific individuals or roles**)
  - Assignment logic: **"Assign to – Any"** (first completion advances) vs **"Assign to – All"** (all must complete)
  - Automated reminders to evaluators
  - **Auto-approval** to advance a stage after N days of inactivity
  - Feedback forms submitted by both the probationer and reviewers
  - Timing controls: days before probation end to trigger evaluation; deadline for feedback
- Policies cannot be deleted if default or assigned to active employees.
- Related FAQs **[DOC]**: "How to update probation policy settings?", "How to change the Probation status of Employees?", "How to see the employees who are in probation?", "How to extend the probation end date?", "How to change the days for when probation feedback form is triggered?", "How to set up an employee probation feedback form?", "How to get the report for probation confirmed employees?"

### A4.5 Transfers & promotions

**[DOC]** Keka does not document a separate "transfer" or "promotion" module. Instead:
- Job title / department / position changes are made on the employee profile with an **effective date** — "particularly useful during promotions or departmental transfers".
- **Job details change history** is retained: "Where can we view the history of Job details change?" and "Employee timeline change history review" FAQs.
- **Bulk job-detail edits**: "Editing or adding employee job details in bulk".
- Salary side of a promotion is handled by **salary revisions** in Payroll (with retro/arrears — see Part B).
- **[UNCERTAIN]** Whether there is a dedicated promotion/transfer *workflow with approval and letter generation* is not documented in the articles found; letters would be generated via Document Templates. Flag for verification.

### A4.6 Exit / offboarding

**Sources:**
- Overview: `https://help.keka.com/hc/en-us/articles/39946725816209-Employee-exits-on-Keka-Overview`
- Initiating: `https://help.keka.com/hc/en-us/articles/39946630255761-Initiating-the-Exit-Process`
- Exit process tab: `https://help.keka.com/hc/en-us/articles/39946791454865-Understanding-the-Exit-Process-Tab-in-Keka`
- Notice period: `https://help.keka.com/hc/en-us/articles/39946768364305-Creating-and-Managing-Notice-Period-Settings`
- Exit tasks: `https://help.keka.com/hc/en-us/articles/39946822053265-Configuring-Exit-Tasks-in-Keka`
- Backfill: `https://help.keka.com/hc/en-us/articles/41513631754001-Raise-Backfill-Requisition-from-Exit-Approval`
- Settings/reasons: `https://help.keka.com/hc/en-us/articles/39946721627281-Managing-resignation-termination-settings-and-exit-reasons`

**[DOC] Initiating an exit** — Employee profile → three-dot menu → **Initiate Exit**. Exit can be initiated by employees, managers, HR admins, or authorised roles ("How can employees Initiate Exit?"). Form fields:
- **Exit reason** (resignation vs termination classification; reason list is configurable — "Exit reason expansion for resignations and terminations")
- **Discussion documentation** — whether management met the departing employee
- **Notice date** — when resignation/termination was communicated
- **Last working day** — auto-calculated from the notice-period policy, or manually overridden by an authorised user
- **Rehire eligibility** — decision on future re-employment
- **Supporting files** attachment

After submission the request enters an **approval workflow**; after approval the employee moves through asset recovery and final settlement.

**[DOC] Other documented exit capabilities:**
- **Notice period settings** — periods "can vary based on company policies or the employee's role"; extension of LWD supported ("How to remove extension of Last Working Day?")
- **Exit task lists** — "Create specific exit task lists for various groups of employees", including **asset returns** and **exit surveys**; tasks auto-assign on exit initiation; clearance is spread across multiple stakeholders
- **Tracking** — see all employees in exit, monitor task progress, cancel an exit ("How to cancel an employee's resignation once it is approved?")
- **Retaining an employee in the exit process** (withdraw resignation)
- **Initiating Exits and Settlements in Bulk**
- **Backfill requisition** can be raised straight from exit approval (links to Keka Hire)
- **Relieved employee report** ("Where to find the relieved employee report?")

**[DOC] Exit survey / exit interview** — `https://help.keka.com/admin/configuring-exit-survey`
- Path: **Org → Exits tab → Exit Survey**
- Admins **Add Question** / edit existing questions, then Update
- Responses: **Exits → Exit Survey → View Responses**, filterable, **downloadable as Excel**
- FAQs: "How to Download Exit Survey Responses Report", "How to Edit the Employee Exit Survey Form?", "Exit survey form activation guidance", "Exit survey form release troubleshooting"
- **Plan note:** the pricing page lists **"Employee Exit Surveys" under the Strength plan** (not Foundation) **[DOC]**
- **[UNCERTAIN]** Anonymity settings and question types are not documented in the articles found.

F&F settlement is covered in Part B (it is a payroll function).

---

## A5. Document management, letters and e-signature

### A5.1 Employee documents

**Source:** `https://help.keka.com/hc/en-us/articles/39946717792145-Managing-Employee-Documents`

**[DOC]** The Employee Documents tab organises documents into four status tabs:
- **Pending Verification** — uploaded by employees, awaiting admin review
- **Pending on Employee** — "mandatory documents that employees are yet to submit"
- **Verified Documents** — approved; view / download / delete
- **Expiring Documents** — expired or soon-to-expire items

**Document folders** — custom folders with role-based access:
- Folder name and description
- **Mark folder as confidential** for restricted access
- Role-specific permissions (**Employee-Self, Reporting Manager, Department Head**), with view and edit rights per role

**Document types** — per-type settings:
- **Upload Frequency** — single or multiple uploads per type
- **Mandatory Status** — "Marks the document as required for submission"
- **Verification Requirements** — routes to admin approval
- **Expiry Tracking** — "Prompts employee to enter expiry details"
- **Not Applicable Option** — employee can mark it irrelevant

**Other [DOC]:** bulk document upload with batch deletion; "Bulk importing Employee Documents"; "How to send reminders to employees who have not submitted any Employee Document?"; "How to upload employee documents in bulk?"; "How to download employee documents?"; **Document Custom Fields** ("Understanding Document Custom Fields"); "How to update Documents field or folder settings?"

**Document expiry tracking [DOC]:** dedicated article "Managing Expired and Expiring Employee Documents" — `https://help.keka.com/hc/en-us/articles/39946780445457-Managing-Expired-and-Expiring-Employee-Documents`

### A5.2 Organisation documents (policies)

**[DOC]** "Managing Organization Documents" + **"Enforcing acknowledgement for org documents"** — org-level policy documents can require employee acknowledgement. FAQs: "How to download an organizational policy document uploaded in Keka?", "Organization document access for employees".
(Direct fetch of the org-documents article was robots-blocked; the feature is confirmed by the Core HR index and FAQ titles.)

### A5.3 Document / letter templates

**Source:** `https://help.keka.com/hc/en-us/articles/39946772476817-Creating-and-Managing-Document-Templates`

**[DOC]** Two template types:

**1. Document Generation Templates (letter templates)**
- Explicitly named use cases in the docs: **offer letters, confirmation letters, relieving letters** — "templates across the employee lifecycle, from onboarding through exit"
- **Dynamic placeholders** that auto-populate employee name, dates, designation, signatures, **and custom fields**
- Two authoring routes: **built-in web editor** or **upload an existing MS Word document** ("How to upload employee letter templates in MS word format to Keka?")
- **Document workflows** can be attached requiring **"acknowledge, approval or signature"** — `Creating document workflows for document templates`
- **Access management**: view / edit / download permissions by role and by **designation**; scope to specific **legal entities** or org-wide
- **Folders** for storage/retrieval
- **Archive / unarchive** — archiving stops new generation but preserves already-generated documents
- **Clone letter template** ("How to clone letter template?")
- Generation: "How to generate employee letters?" (`https://help.keka.com/hc/en-us/articles/39946880264081`), "Edit and Customize Document Templates" (`https://help.keka.com/hc/en-us/articles/41059994466449`), "How to create a new Letter Template on Keka?" (`https://help.keka.com/hc/en-us/articles/39946702377233-How-to-create-a-new-Letter-Template-on-Keka`)

**2. Upload Request Templates**
- Used to request specific documents from employees (driving licence, voter ID, etc.) with custom fields
- Employees respond via Profile → Documents tab → "Add Details"

**[UNCERTAIN]** Keka's docs name offer / confirmation / relieving letters explicitly. **Appointment letters and experience letters** are not named in the articles I could read — they would be built as custom templates rather than being pre-built letter types. Flag for verification.

### A5.4 Digital signature / e-signature

**[DOC]**
- **DocuSign** integration: "How to generate document with digital signature using DocuSign" (`https://help.keka.com/hc/en-us/articles/39946796352017-How-to-generate-document-with-digital-signature-using-DocuSign`) and "DocuSign integration for signing offer letters" / "Integrating Docusign in Keka" (`https://help.keka.com/hc/en-us/articles/39946820072209-Integrating-Docusign-in-Keka`)
- **Marketplace e-sign apps**: DocuSign, **emSigner (Paperless Office by eMudhra)**, **TRUESigner ONE Enterprise** (Truecopy)
- **Open e-sign partner programme**: `https://developers.keka.com/docs/esign-partners-guide` — vendors build an "eSignature App" via the Keka App portal, register under the **Document Management** category, authenticate via OAuth, receive signing requests by **webhook**, and upload signed documents back via REST API. "Initiate document signing through Keka with approval workflows and upload the signed documents back to Keka."
- **Separate**: a **Document Signer App** is used for **Form 16** digital signing (see Part B).

---

## A6. Engagement, announcements, directory

**[DOC]**
- **Announcements** — "Using Announcements to Engage Your Employees"
- **Polls** — "Using polls to engage your employees"; "How can we edit an already released Poll?"
- **Surveys** — "Surveys in Keka HR"
- **Pulse / Pulse 2.0** — "Introduction to Pulse 2.0", "Launching and Managing Pulse for your Organization", "Gathering Employee Responses for Pulse", "Analyzing Pulse Data" (**Growth plan** per pricing: "Employee Pulse Surveys")
- **Feedback & Praise (praise wall)** — "Boosting Your Success Journey: Feedback and Praise"; "How to Give Praise to an Employee in Keka?" (`https://help.keka.com/hc/en-us/articles/39838176470289-How-to-Give-Praise-to-an-Employee-in-Keka`); mobile app variants; "How to fetch a report on the praises given to an employee". Pricing lists **"Public Praise"** and **"Employee Expression Wall"** under the **Growth** plan **[DOC]**
- **Articles / posts** — "Creating articles to engage your employees"; "How to create a post?"
- **Org Dashboard** — "Org Dashboard Overview"; homepage widgets are customisable ("How can an admin customize the homepage widgets on Keka?"); **quicklinks** to other portals can be added to the homepage
- **Daily Email Digest** — enable/disable and customise
- **Digital ID Card** — "Managing ID Card Settings in Keka"; enable/disable per employee; customise fields on the card
- **Employee directory** — **[UNCERTAIN]** no dedicated "employee directory" help article was located; employee search + profile visibility settings ("Managing Employee Visibility Settings", "How to remove an employee from private profile?") appear to serve this role. Flag for verification.

---

## A7. Helpdesk / ticketing

**Sources:**
- Overview: `https://help.keka.com/hc/en-us/articles/39946632743697-Understanding-Keka-s-Helpdesk`
- Categories: `https://help.keka.com/hc/en-us/articles/48866672049681-Creating-a-New-Helpdesk-Category`
- Settings: `https://help.keka.com/hc/en-us/articles/39946725231249-Managing-Helpdesk-Settings`
- Tickets: `https://help.keka.com/hc/en-us/articles/39946710748049-Managing-Helpdesk-Tickets`
- Summary tab: `https://help.keka.com/hc/en-us/articles/39946838983569-Understanding-the-Helpdesk-Summary-Tab`
- Reports: `https://help.keka.com/hc/en-us/articles/39946611826321-Accessing-Helpdesk-Reports`
- Raising a ticket: `https://help.keka.com/hc/en-us/articles/39946848514321-Raising-and-following-an-internal-ticket`

**[DOC] Positioning:** Keka's Helpdesk is described in its own overview as **"an add-on feature"** that "centralizes ticket-based support for internal requests". *However*, the pricing page lists **"Helpdesk" as a Foundation-plan feature** — so it appears bundled from Foundation upward. **[UNCERTAIN]** — reconcile "add-on" wording vs pricing-page inclusion.

**[DOC] Category configuration** (this is where SLA lives):
- **Category name and description**
- **Audience** — all employees, specific individuals, or groups
- **Category head** assignment
- **Business hours** configuration
- **Sub-categories** — "Select **Yes** if you want to create sub-categories with different priority values"
- **SLA**: per **priority level (High / Medium / Low)**, set **"First Response time"** and **"Expected resolution time"**; set a **default priority** for new tickets
- **Escalation** — two triggers: (a) ticket without timely first response, (b) ticket unresolved beyond expected timeframe. Escalations route to **designated employees** with **configurable durations**
- **Ticket behaviour** — "On Hold" status; employees may reopen closed tickets (toggle); who may change priority (assignee / category head / ticket raiser)
- **Auto-assignment** — roles or employees designated as **category assignees**; optional **follower** notification
- **Canned responses** and **closing responses** for consistent comms

**[DOC] Analytics:** dashboard shows open vs closed tickets, **average resolution time**, monthly volumes, **first-response times**; exportable via Reports.

Screenshots: `https://help.keka.com/hc/article_attachments/48866610732817` through `.../48866672038801` (11 images in the category article), plus `.../45609238874769`, `.../48937273600273`, `.../45609275515665` in the settings article.

---

## A8. Asset management

**Sources:** `https://help.keka.com/hc/en-us/articles/39946708828305-Managing-Assets-in-Keka`, plus the Assets sub-section.

**[DOC]** Purpose statements from the docs: "Track asset assignments and ownership", "Monitor asset conditions to plan maintenance or replacements", "**Recover charges from employees in case of damages**".

- Admin path: **Org → Assets**. Employee path: **Employee Profile → Assets tab**.
- Documented articles (each a feature): **Adding An Asset**, **Asset categories & Asset types**, **Managing Asset ID Series**, **Managing Asset Conditions**, **Requesting Assets** (employee-raised asset requests), **Assigning Assets**, **Managing Asset Acknowledgement**, **Recovering Asset damage charges**, **Asset Reports**, **Marking an asset as unavailable**
- FAQs: "How to add assets to an employee (Individually & Bulk)?", "How to edit asset details for assigned assets?", "How to delete an asset?"
- **Payroll link [DOC]:** asset **damage charges** appear as a payable/deductible line in the **F&F settlement** ("Assets: Damage charges") — see Part B.
- **Onboarding link [DOC]:** onboarding automatically handles "assigning assets".
- **Plan note [DOC]:** pricing page lists **"Asset Tracking" under the Strength plan**.

---

## A9. Roles, permissions and approval chains

**Source:** `https://help.keka.com/hc/en-us/articles/39946719445393-Overview-Roles-Permissions`

**[DOC]** Two role families:

**User Roles (explicit, administratively assigned)** — predefined examples named in docs: **Global Admin, HR Manager, Payroll Manager**. Control "Managing employee records", "Running payroll", "Approving settlements".

**Implicit Roles (automatic, position-derived)** — **Reporting Manager, Department Head, Business Head**. Enable "Approving leave and expenses", "Accessing documents for direct reports". Permissions of implicit roles are themselves editable ("How to update the permissions of Implicit roles within Keka?").

- **Custom roles**: organisations create roles by "selecting the exact permissions users should have".
- Both families "can be **customized** to support approval chains or to grant access to critical processes."
- **Plan note [DOC]:** "Standard Access Roles" = Foundation; **"Advanced Roles & Permissions" = Strength plan**.
- Related: "Understanding Implicit Roles", "Understanding User Roles", "Managing Global Roles & Permissions in PSA" (PSA has its own role model), "How to add an external user on Keka?"

**Approval chains [DOC]** — Keka uses configurable approval chains in several distinct places rather than one global workflow engine:
- **Expense category-level approval chains** — `https://help.keka.com/hc/en-us/articles/39946601457553-Configuring-approval-chain-at-expense-category-level`
- **Loan policy approval chains** — role-based approvers with auto-approve/skip after N days
- **Probation evaluation chains** — multi-level, Any/All, auto-approve after N days
- **Payroll maker-checker approval workflow** — Lock Payroll and Compensation Change (see Part B)
- **Exit approval workflow**
- **Offer letter approval**
- **Document workflows** — acknowledge / approve / sign
- FAQ: "Why would a level of approval get skipped?"

**[UNCERTAIN]** There is no evidence of a single generic "custom workflow builder" spanning arbitrary objects; approvals are configured per module. Flag for verification.

---

## A10. Core HR reports & analytics

**[DOC]** Core HR Analytics & Reports sub-section contains three headline articles:
- **Tracking Growth, Exits and Retention using Analytics** — `https://help.keka.com/admin/tracking-growth-exits-and-retention-using-analytics`
- **Using Keka Employee Analytics — Tracking your demographics**
- **Tracking attrition in the organization**

**Growth & Retention metrics documented [DOC]:**
| Metric | Definition (as documented) |
|---|---|
| Growth Rate | "growth in number of employees over the last year" |
| Retention Rate | "how many employees who initiated the exit process were retained in the organization over the past year" |
| Attrition Rate | percentage of employees who departed |
| Total Attrition | actual count of employees who left during the year |

Plus: monthly breakdown of growth trends with filters and hover detail; retention shown as monthly percentages; **time-period filtering**; **export to PNG / PDF**; **department and location filtering**.

**Other named Core HR reports [DOC]** (from FAQ titles):
- Employees and their Reporting Managers report
- Probation-confirmed employees report
- Employees in notice period
- Work anniversary report
- Employee attrition report
- Employee demography reports
- Relieved employee report
- Exit survey responses report
- Praise report (praises given to an employee)
- Login history / email history of employees
- Employees whose login is disabled
- Cost Center-wise Expense report
- Job details change history / employee timeline

**Report automation [DOC]:** "Keka's New Report Emailing Automation" — `https://help.keka.com/hc/en-us/articles/39946790828433-Keka-s-New-Report-Emailing-Automation` (scheduled report emailing).
**Plan note [DOC]:** **"Custom Reports Builder" is a Strength-plan feature**; "Dashboards and Analytics" is Foundation; **"People Analytics" is Growth**.

---

## A11. Notifications & integrations (Core HR)

**[DOC]**
- **Email notifications** — "Configuring Email Notifications"; "How to edit default email triggers for various modules on Keka?"; daily email digest customisation; "How to unblock an employee's Email?"
- **Slack** — "Configuring Slack Notifications", "Setting up a Slack App and Incoming Webhooks in Slack"
- **Webhooks** — "Configuring Webhooks", "Manage Event Triggers"
- **SSO** — Okta, Azure AD (+ FAQ), OneLogin, JumpCloud, Google Suite. **Plan note [DOC]: Single Sign-On is a Strength-plan feature**; also "Login Using Mobile OTP" (Strength)
- **Two-factor authentication** — "How to log in to Keka using two factor authentication?"
- **IP whitelisting** — "IP whitelisting configurations" + FAQs
- **API & Webhooks** — listed as a **Foundation** feature on pricing; developer docs at `developers.keka.com`
- **Calendar** — "Integrating Keka Classroom with your calendar"
- **[DOC] Marketplace** (`https://www.keka.com/marketplace-all-apps`) — 50+ apps. Named: DocuSign, emSigner/eMudhra, TRUESigner ONE Enterprise; SpringVerify, cFIRST BGV, InstaVeritas, HelloVerify BGV, Checkr; Zoho Books for Payroll, **Tally for Payroll**, QuickBooks for Invoicing, Xero for Keka PSA; Azure AD, Okta, OneLogin, Google Suite, JumpCloud; Slack, MS Teams / Zoom / Google Meet / Outlook Calendar (1:1 check-ins); LinkedIn, Indeed, Naukri, Monster, Glassdoor, CareerBuilder; Keka Learn LMS, Udemy, Violet LMS, Abara LMS, Disprz LMS; SimplyInsured, Guideline, Onsurity, Plum Insurance; Salesforce, Mercer Mettl, HackerEarth.
- **Plan note [DOC]:** "Slack and MS Teams integration" and "Custom Notifications" are **Strength**-plan features.

---

# PART B — PAYROLL

## B0. Where Payroll lives in the help centre

Admin Help Center → **Payroll**: `https://help.keka.com/hc/en-us/sections/39011023299729-Payroll`

| Sub-section | URL |
|---|---|
| Payroll setup & processing | `https://help.keka.com/hc/en-us/sections/39012476193041-Payroll-setup-processing` |
| Run Payroll | `https://help.keka.com/hc/en-us/sections/39012477442577-Run-Payroll` |
| Statutory Compliances | `https://help.keka.com/hc/en-us/sections/39012461020561-Statutory-Compliances` |
| Loans & Advances | `https://help.keka.com/hc/en-us/sections/39013095228049-Loans-Advances` |
| Payslip Management | `https://help.keka.com/hc/en-us/sections/39012487987729-Payslip-Management` |
| Managing perks, and component claims | `https://help.keka.com/hc/en-us/sections/39012474212753-Managing-perks-and-component-claims` |
| Income Tax | `https://help.keka.com/hc/en-us/sections/39012453659665-Income-Tax` |
| Analytics and Reports | `https://help.keka.com/hc/en-us/sections/39928143088273-Analytics-and-Reports` |
| Employee Salary Management | `https://help.keka.com/hc/en-us/sections/39012452138513-Employee-Salary-Management` |
| Expense Management | `https://help.keka.com/hc/en-us/sections/39012452900625-Expense-Management` |
| **US Payroll** | `https://help.keka.com/hc/en-us/sections/39012522231953-US-Payroll` |
| **AE Payroll** (UAE / GCC) | `https://help.keka.com/hc/en-us/sections/39928140951185-AE-Payroll` |
| Payroll FAQs | `https://help.keka.com/hc/en-us/sections/39012475535121-Payroll-FAQs` |

The **legacy index** `https://help.keka.com/admin/payroll` is the single most complete inventory of payroll functionality (100+ FAQ titles, each one a feature). It is the best source for an exhaustive feature list.

---

## B1. The payroll run — Keka's 6 steps (named and explained)

**Primary source:** `https://help.keka.com/hc/en-us/articles/39946563404561-Running-payroll-on-Keka` **[DOC]**
(Marketing video: "Processing Payroll in 6 Simple Steps l Keka HR" — `https://www.youtube.com/watch?v=7Iux49bD6ZM`)

Keka's payroll run is a **6-step guided wizard**. Each step is completed with "Save & Close" and the month is finalised at the end. The official step names and content:

### Step 1 — **Leave, Attendance & Daily Wages**
- **Managing Leave Applied** — review all approved and pending leave requests for the month; approve/reject pending ones with reasoning before proceeding.
- **Managing No-Attendance Days** — identify employees with missing attendance records; use the **"Deduct Leave"** action to assign a leave type and number of days. *"If you skip the 'No attendance days' sub-step and proceed, the system will warn you of mismatches."*
- **Managing Loss of Pay (LOP)** — review system-calculated LOP days per employee; **LOP Adjustment** tab allows manual modification with notes; **"LOP Reversal from previous months"** lets you reverse past-month LOP days manually or via **Excel bulk import**.
- **Payable Units** — compensation for employees paid **daily, hourly, or per-unit**; privileged users may override; **Excel bulk import** supported.
- *Tip in docs:* "Ensure leave and attendance records are fully updated before you begin Step 1 so LOP/absences reflect correctly."
- Screenshot: `https://help.keka.com/hc/article_attachments/40555431635345`

### Step 2 — **New Joinees & Exits**
- **New Joinees** — employees who joined this month. **Pay Action** options: *Hold salary processing · Process as salary · Void salary processing · Hold payout · Void payout · Already paid*. Expandable rows show salary, working days, payable amount. Per-employee comments.
- **Employees in Exit Process** — set Pay Action and comments per employee.
- **Full & Final Settlements** — employees with completed exits but pending F&F. "Click here" under Actions opens the settlement page. Status moves **Approved → Finalized**. All settlements must be complete before finishing the step.
- Screenshot: `https://help.keka.com/hc/article_attachments/40555411317393`

### Step 3 — **Bonus, Salary Revisions & Overtime**
- **Bonus** — Pay Action: *Pay · On Hold · Void · Pay Outside Keka Payroll · Partially Pay*.
- **Salary Revisions** — employees whose salary change is effective this cycle; shows **old salary, new salary, and % change**; options *Continue Hold* or *Release salary*.
- **Overtime Payment** — amounts adjustable; Pay Action: *Pay · Void · Mark as Paid Outside Keka Payroll*.
- **Shift Allowance** — amounts modifiable; Pay Action: *Pay · Hold · Void · Paid Outside Keka Payroll*.
- Screenshot: `https://help.keka.com/hc/article_attachments/40555411327761`

### Step 4 — **Reimbursements, Ad-hoc Payments, Deductions**
- **Salary Component Claims** — employee claims against payroll-eligible components. "Review Claim" popup allows editing the **payable amount**, setting the **payout month**, comments, and viewing **claim attachments**; Approve or Reject.
- **Expenses** — approve/reject **cash advance requests**; review **advance settlements** and **expense claims** for payment.
- **Ad-hoc Payments** — "Add Employee" (search employee, add type, amount, comments); **bulk import** via "Import Adhoc Payments" Excel template.
- **Ad-hoc Deductions** — same pattern; **bulk import** via "Import Adhoc Deductions" Excel template.
- Screenshot: `https://help.keka.com/hc/article_attachments/40555411333905`

### Step 5 — **Salary on Hold & Arrears**
- **Salary Processing on Hold** — for absconding / uninformed leave etc. Documented consequence: *"the employee will not appear in pay register; no components get values; no statutory contributions/deductions apply"*. Add employees via "+ Add Employee" or bulk import. Per-employee action: *Continue Hold · Process as Usual · Void Processing*.
- **Salary Payout on Hold** — distinct from processing hold: *"salary still processes and includes statutory calculations… The payout will be held — no payment will be made yet"*, and you *"Release the payout later whenever required (e.g., after notice period or leave clarification)."*
- **Arrears** — arrears arise from four documented sources: **past-dated salary revisions, salary holds, LOP reversals, and arrear-LOP recoveries**.
- Screenshot: `https://help.keka.com/hc/article_attachments/40555411343633`

### Step 6 — **Overrides (PT, ESI, TDS, LWF) & Finalizing Payroll**
- **Override statutory component values** — **Professional Tax, ESI, TDS, Labour Welfare Fund** can be overridden for one-off adjustments.
- Review the complete payroll summary; verify no outstanding holds or unhandled items.
- **"Save & Close"** completes the run and marks the month **Completed** (payroll is locked).
- **Payroll Outcome** — after locking, a banner and a **"Manage payslips"** card appear if payslips are not fully released. The card shows total employees, released payslips, and unreleased/on-hold counts. **"Release Payslips"** opens the payslip release workflow. The Release Payslips CTA remains available even when the Payroll Outcome section is collapsed; the banner/card disappear once all payslips are released.
- Screenshot: `https://help.keka.com/hc/article_attachments/40555411347601`

### Related run-payroll capabilities **[DOC]**
- **Roll back payroll** — "What are the Consequences of Rolling back a payroll?", "How to roll back the payroll of some employees or of an entire pay group"
- **Errors** — "Understanding Errors and Guided Fixes in Keka" (`.../39946817596305`), "How to check for errors if the payroll gets aborted"
- **Attendance cut-off date for payroll processing** is configurable
- **Provisional payslip** state exists ("Why is the payslip marked 'provisional'?")
- **Negative salaries** in payslip/pay register — documented FAQ ("Can Keka display negative salaries in Payslip/Payregister?")

---

## B2. Maker-checker / payroll approval workflow

**Source:** `https://help.keka.com/hc/en-us/articles/41388353533073-Approval-Workflow-Maker-Checker-for-Payroll-Finalisation` **[DOC]**

- Path: **Payroll Settings → Approval Workflow**. Define **custom approval chains**; multiple rules based on criteria; each rule specifies a chain of **approver roles**.
- **Two actions support approval workflows: (1) Lock Payroll, (2) Compensation Change** (salary/bonus updates).
- With it enabled, the **"Lock Payroll" button becomes "Lock & Send for Approval"**. Request goes pending; **initiator can withdraw** before approver action; payroll stays unlocked during review.
- For payroll settings changes, a **pending icon** appears next to the modified setting; on approval "the settings change takes effect, which triggers a **salary-structure regeneration** for employees."
- Approvals land in **Inbox → Taken Action → Payroll → Approve**; approve or reject; comments visible in activity logs.
- **Restrictions:** future payroll processing is blocked while a Lock Payroll request is pending; no additional salary/bonus actions while changes are pending; users cannot submit multiple salary revisions simultaneously.
- **"Only explicit user roles are shown. Implicit/system roles are hidden"** in approval chains.
- Screenshots: `https://help.keka.com/hc/article_attachments/41388364330257`, `41388353518097`, `41388353518993`, `41388364335633`, `41388364336529`, `41388364337297`, `41388364339345`, `41388364340753`, `41388364341905`, `41388364343057`, `41388364344593`

---

## B3. Pay groups

**Source:** `https://help.keka.com/hc/en-us/articles/39946630038673-Creating-and-configuring-a-new-pay-group` **[DOC]**

A **pay group** "helps companies organize employees by payroll policies, schedules, and statutory requirements" — it is the main payroll configuration container. Multiple pay groups per tenant.

Configuration areas:
1. **Pay Schedule** — payroll start date; pay schedule end date (typically last day of the month for compliance alignment). Editable later: "Editing Pay Schedule for a Pay Group" / "How to change the pay cycle of a pay group".
2. **Contributions and Deductions** — enable/disable **PF, ESI, LWF, PT**; for each, enter **registration numbers, dates, and signatory information**.
3. **Salary Structure** — salary ranges/bands (default suggestions "Class A–D" by annual compensation threshold); add/edit/delete ranges.
4. **Salary Components** — predefined tax-optimised components or custom ones; calculation as **fixed amount, percentage, or custom formula**; designate earnings vs deductions, taxable vs non-taxable.
5. **Declaration and Proof Submission Timelines** — monthly declaration window (e.g. 1st–22nd); FY cut-off date; special provision for new joiners (**30 days, or by 22 February**); proof-submission due dates.
6. **Payroll Data Imports** — current and previous salaries; financial information (**PAN, bank details, PF numbers**); investment declarations.

**Other pay-group operations [DOC]:** "Importing pay group assignments in bulk"; "How to migrate an employee from one pay group to another pay group?"; "From where can we see the pay group changes made for any employee?"; "Viewing and managing employee pay groups".

Screenshots (16 in that article): `https://help.keka.com/hc/article_attachments/40554214949521`, `40554184072721`, `40554214950033`, `40554214951057`, `40554184074385`, `40554184075153`, `40554184077073`, `40554214953361`, `40554184077969`, `40554214954769`, `40554214955409`, `40554214956305`, `40554184082449`, `40554184083089`, `40554214959249`, `40554184086289`

---

## B4. Salary structures, components, CTC breakup, FBP

### B4.1 Salary structures
**Source:** `https://help.keka.com/hc/en-us/articles/39946778678289-Creating-and-managing-salary-structures-for-a-pay-group` **[DOC]**

"Salary structures define how an employee's pay is broken down — what components are included and how much value each holds."

**Three documented structure types:**
1. **Range-Based Structures** — predefined, grouped by salary ranges; editable limits and names; ranges can be **split** and deleted.
2. **Custom Salary Structures** — replicate org-specific formats; toggle **PF/ESI settings and TDS methods** per structure; add/edit components with formulas or fixed values; **clone** an existing structure.
3. **Daily Wage Structures** — for daily-paid employees; multiple variants; edit/clone/delete via Actions column.

**Formula types [DOC]:**
- Fixed values
- Annual-based calculations (documented example: **"PF = 12% of Basic Annual"**)
- Hourly rates for overtime (documented example: **"Annual Basic / 2920"**)
- Worked example in docs: Monthly Basic ₹15,000 = ₹180,000 annual; 12% PF = ₹21,600/year
- **Nested IF statements** are supported — "Understanding Nested IF Statements for Calculating Employee Payables on Keka Portal" **[DOC]**
- "How to configure/update the hourly OT formula used for OT calculation?"

**Flexible Benefits Plan (FBP) [DOC]:** check **"Salary Structure is Part of Flexible Benefits Plan"** to enable employee tax-saving benefit selection and claim submission. Also "How to make a component in a salary structure a part of FBP?" and "How can an employee claim the FBP components?".

**Other structure operations [DOC]:** "How to create/edit a new/custom salary structure"; "How to change the salary structure of an employee" / "…in bulk"; "How to delete any component from a salary structure?"; "How to round off the salary components?"; "How to add/change the formula of a component"; "How to enable or disable the calculation of arrears for any components"; "How to create a salary structure for interns where the only component is stipend"; "How to make a component (like Food Coupons) part of both earnings and deductions"; "How to change the Annual Limit or Section Maximum Limit for a component?"; "How to add NPS in the salary structure"; "How to check Components and Salary Structures under a Paygroup?".

Screenshots (23 in that article) include `https://help.keka.com/hc/article_attachments/40542561554449`, `40542561554961`, `40542592067729`, `40542592068881`, `40542561558161`, `40542561560209`, `40542592070417`, `40542561560977`, `40542561562129`, `40542561562769`, `40542592075921`, `40542592076305`, `40542561564945`, `40542592078225`, `40542561569297`, `40542561569553`, `40542592081041`, `40542592081553`, `40542592082705`, `40542561575441`, plus two animated GIFs on HubSpot CDN.

### B4.2 Salary components
**Source:** `https://help.keka.com/hc/en-us/articles/39946721937681-Managing-salary-components` **[DOC]**

Two documented categories:
- **Recurring Components** — "Paid to employees in every pay cycle. Independent of performance or other conditions." Examples: **Basic, HRA, Dearness Allowance**.
- **Ad-hoc Components** — "Added or deducted as needed, not part of regular salary." Examples: **Joining Bonus, Referral Bonus, Salary Advance Recovery, Asset Damage Recovery**.

Other documented rules:
- Components can be **taxable or partially exempt** per tax regulations.
- Some recurring components are **system-mandated and locked** from editing.
- **Three-step setup flow:** add to a **global repository** → assign to **pay groups** → include in **salary structures**.
- Diagram: `https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/6UfWdD46HAyrw-DLGAoEbGIK2weSHCp0mg.png`
- Related: "Managing Earnings and Deductions in Keka" (`.../39946786502801`); "Assign Earning Section to Salary Components for Tax Reporting" (`.../41743176157073`); "Threshold value for a component to be effected by LOP" (`.../39946770080657`); "How to pay a certain component over and above the CTC of the employees?"; "How to show components marked as outside annual salary in the payslip?"; "Include Outside Annual Salary Components in Tax Computation" (`.../42748406580625`); "Pay Register Visibility for Outside CTC Contributions" (`.../47955353405329`); "How to enable/disable the override option for any salary component?"; "How to override salary components?" / "How to remove overrides?".

### B4.3 Remuneration types
**[DOC]** Keka supports multiple remuneration bases, each with its own setup article:
- **Monthly** and **Hourly** — "Introducing Monthly & Hourly Remuneration in Keka" (`.../39946700255761`); "Setting Up and Managing Hourly Remuneration in Keka" (`.../39946781489937`)
- **Piece-based / per-unit** — "How to Configure and Use Piece-Based Remuneration in Keka" (`.../39946830193041`); "Piece-Based Remuneration" (`.../39946830050449`); US variant "Piece/Unit Based Remuneration" (`.../39946798548625`)
- **Daily wage** — daily wage salary structures
- **Switching Remuneration Type of Employees** (`.../39946713584657`)
- US-only: **Multiple Pay Rates** (`.../39946830406929`, `.../39946815359249`)

### B4.4 Pay grades / bands / compensation analytics
**[DOC]**
- **Pay Grades** — "Adding and editing Pay Grades" (Core HR); **Bands** — "Adding and modifying Bands"
- **Compensation analytics articles**: "Compensation Planning" (`.../39946882192657`), "Estimating Compensation Budgets" (`.../39946750081937`), "Compare Compensation Cost" (`.../39946698983185`), "Comparing Employee Competitiveness" (`.../39946630066193`), "Understanding the Geographical Differentials Tab in Payroll Analytics" (`.../39946721899665`)
- **[UNCERTAIN]** The Compensation Planning article is video-only in the version I could fetch; budget/increment-letter specifics not confirmed in text. Flag for verification.

### B4.5 Perks (perquisites)
**Source:** `https://help.keka.com/hc/en-us/articles/39946757222289-Adding-and-Managing-Perks` **[DOC]**

- Documented examples: **Company Car / Transportation Benefits, Meal Card or Passes, Skill Development Reimbursement**.
- **Perk categories** chosen from a pre-configured dropdown.
- **Taxable vs non-taxable perquisites** configurable, including **who bears the tax (employer or employee)** and an **exclusion option under section 192(1A)** when the employer pays the tax.
- **Three value-calculation methods:** fixed amount for all employees · formula-based (tied to salary components) · individual per-employee custom values.
- "Assigning perks to employees" (`.../39946713478929`); "Approving or Rejecting Component Claims" (`.../39946699094417`).
- **Note [DOC]:** perks **cannot** be configured in the pay register (stated in the pay-register customisation article).

### B4.6 Tax-saving reimbursements (FBP claims)
**Source:** `https://help.keka.com/hc/en-us/articles/39946778649489-Understanding-Tax-Saving-Reimbursements` **[DOC]**

- Reimbursements are **"Not considered part of taxable income"** and **"Not reported to the Income Tax (IT) department"**; they do **not** appear on Form 16; they are issued via a **separate ("segregated") payslip**.
- Documented examples: **fuel/petrol reimbursement, car reimbursement, internet and telephone reimbursement, driver reimbursement**.
- Key distinction documented: **reimbursements** (tax-exempt) vs **reimbursable components** (taxable) — both are claimed the same way.
- Employee access: **My Finances → My Pay → Payslips → segregated payslip** (appears only when reimbursements were paid).
- **Critical documented rule:** *"If employees don't claim reimbursements, amounts convert to taxable income under Special Allowance."*
- Admin override: "Manually overriding reimbursable component claims" (`.../39946584056337`); report: "How to download component claim report?"
- Screenshots: `https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-30-2025-10-25-02-1308-AM.png`, `...10-37-28-8876-AM.png`, `...10-39-59-9258-AM.png`

### B4.7 Bonus
**[DOC]**
- "Configuring and processing Earned bonus on Keka" (`.../39946718082449`)
- "Adding Bonus as part of Annual Salary" (`.../39946711702033`)
- "Importing bonuses with payout date in bulk" (`.../39946711756945`)
- FAQs: create a new bonus type and assign it · change bonus payout date · pay a bonus partially · pay bonuses outside of payroll · edit/delete previously added bonus · **settings for tax calculation on bonuses** · **include bonus/one-time payment for ESI calculation** · Bonus Status Report

### B4.8 Salary revisions, arrears and retro effect
**[DOC]**
- "Importing salary and salary structure revisions in bulk" (`.../39946726268305`)
- FAQs: "How to revise the salary of an employee? **What is its impact on the calculation of arrears?**"; "How to edit a revised salary for an employee on Keka?"; "How to delete a salary revision for an employee?"; "What will happen if the salary revision is given in the middle of the pay cycle?"; "Where to find the report for all salary revisions".
- **Arrears** — "**What is the formula used for arrear calculation?**", "How are arrears calculated?", "**How do arrears impact the tax calculation?**", "How to enable or disable the calculation of arrears for any components".
- Arrears sources per the run-payroll doc: past-dated salary revisions, salary holds, LOP reversals, arrear-LOP recoveries.
- **ESI Calculation Fix: Including Arrears in ESI Contributions** (`.../41208072170385`) — arrears are included in ESI wage base.

---

## B5. Indian statutory compliance

### B5.1 Provident Fund (PF / EPF / EPS / VPF)
**Source:** `https://help.keka.com/hc/en-us/articles/39946817571729-Updating-PF-Provident-Fund-settings-for-a-pay-group` **[DOC]**

- Path: **Payroll → Settings → Pay Groups → Configure → Contributions tab → ⋯ → "Update PF Settings"**
- PF can be toggled on/off per pay group — "Switch it off if PF does not apply to this pay group."
- Per-employee / bulk enable-disable: "How to enable/disable PF for individual employee or in bulk"
- **EPF/EPS split is configurable per employee** — "How to change the **EPF/EPS** contribution of an employee?" **[DOC]**
- **VPF (Voluntary Provident Fund)** supported — "How to enable Voluntary Provident Fund (VPF) for employees" **[DOC]**
- **PF proration and its impact on special allowance** is a toggle — "How to enable/disable the impact on special allowance due to PF proration" **[DOC]**
- **PF override** per employee — "How to override Provident Fund (PF) contribution"
- **Preview before finalising** — "Where to preview the PF calculation of an employee before finalizing payroll"
- **PF admin charges report** exists
- **ABRY Compliance on Keka** (Atmanirbhar Bharat Rozgar Yojana) — documented article **[DOC]**
- FAQ: "In PF Monthly Electronic Return (PF ECR), why is the PF wage amount not matching the PF amount PF is calculated on?"

**[UNCERTAIN]** The ₹15,000 PF wage ceiling, 12% rates, EDLI and admin-charge percentages are standard Indian statute and Keka clearly implements them (PF admin charges reports exist), but the specific help article I fetched did not spell out the numbers. Flag for verification against the live product.

**PF statutory forms produced [DOC]** (from the payroll reports article): **Form 6A, Form 10, Form 5, Form 12A, Form 3A**, **PF remittance details**, **monthly ECR**, **administrative charges**, **arrears**.
- "How to generate monthly PF ECR report" — `https://help.keka.com/hc/en-us/articles/39946688739345-How-to-generate-monthly-PF-ECR-report`

### B5.2 ESI (Employees' State Insurance)
**Source:** `https://help.keka.com/hc/en-us/articles/39946725885073-Managing-the-Employees-State-Insurance-ESI-contributions-for-a-pay-group` **[DOC]**

- **Wage limit:** employees with monthly gross below **₹21,000** are covered (or already mid-contribution-cycle).
- **Default rates documented:** *"Employee contribution: **0.75%** of gross salary"*, *"Employer contribution: **3.25%** of gross salary"*; calculations typically use a **capped gross of ₹21,000**.
- **Employer contribution handling — two documented options:**
  1. *"No. Employer's contribution of ESI is paid by employer, over and above the Annual Salary"* (outside CTC)
  2. *"Yes. Employer's contribution of ESI forms a part (and is deducted) from Annual Salary"* (inside CTC) — with an option to **hide it from payslips**
- Toggle ESI on/off per pay group; per-employee enable/disable; **ESI override** per employee and in bulk.
- **Arrears are included in ESI contributions** (`.../41208072170385`).
- Bonus/one-time payments can be included in ESI calculation.
- **ESI forms produced [DOC]:** ESI monthly statements, ESI overrides, **ESI summary reports**, **ESI monthly returns**, **Form 5**. "How to generate monthly ESIC ECR report" — `https://help.keka.com/hc/en-us/articles/39946522070545-How-to-generate-monthly-ESIC-ECR-report`
- Screenshots: `https://help.keka.com/hc/article_attachments/40344254387985`, `40344284738065`, `40344284738833`

### B5.3 Professional Tax (PT) — by state
**[DOC]**
- Enabled/disabled per pay group via the Taxes & Deductions tab (three-dot menu → PT settings).
- **State-specific PT registration details** stored per pay group: **State, Location Name, Establishment ID, Registration Date, Authorized Signatory**, and the list of **linked locations following the same PT rules** — i.e. PT is driven by employee **office location** mapped to a registered state location. **[DOC]**
- **State-specific behaviour is explicitly implemented**, e.g.:
  - **"Professional Tax Calculation in Tamil Nadu by Corporation or Panchayat"** — `https://help.keka.com/hc/en-us/articles/42629831023121-Professional-Tax-Calculation-in-Tamil-Nadu-by-Corporation-or-Panchayat`
  - **"Professional Tax (PT) Deduction for Exit Employees (Half-Yearly & Monthly)"** — `https://help.keka.com/hc/en-us/articles/43889873965329-Professional-Tax-PT-Deduction-for-Exit-Employees-Half-Yearly-Monthly` (confirms Keka handles both **monthly and half-yearly PT states**)
- **PT reports [DOC]:** Monthly PT statements, **state-wise PT reports**, PT overrides.
- FAQs: view/edit PT settings of a pay group · remove PT from salary structure · **override professional tax** · change PT formula in the salary structure.
- **[UNCERTAIN]** A definitive list of which Indian states/slabs are pre-loaded was not found in the docs. Flag for verification.

### B5.4 Labour Welfare Fund (LWF)
**Source:** `https://help.keka.com/hc/en-us/articles/39946712012433-Managing-Labour-Welfare-Fund-LWF-contribution-settings-for-a-pay-group` (+ video version `.../39946871713553`) **[DOC]**

- Path: **Payroll → Settings → Pay Groups → Configure → Contributions → Update LWF Settings**
- **Enable/disable** toggle per pay group
- **Employer contribution options:** deducted from annual salary · paid above annual salary · **option to hide employer contribution from payslip**
- **"Prorating LWF Contributions for New Joiners"** setting
- Registration details stored per state: **State, Establishment ID, Registration Date, Authorized Signatory, linked employee office locations**
- FAQs: "How to check or update the LWF settings?" · "How to override LWF amount of a single employee or employees in bulk" · **"How to map other locations to the registered location for LWF contribution"**
- **LWF statutory forms** are produced (LWF contribution forms) **[DOC]**
- Screenshots: `https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Oct-01-2025-07-05-02-6466-AM.png`, `...07-28-49-0186-AM.png`, `...07-26-45-6532-AM.png`
- **[UNCERTAIN]** The docs do not list which states' LWF are supported or the contribution frequency per state. Flag for verification.

### B5.5 Income tax / TDS
**Sources:** `https://help.keka.com/hc/en-us/articles/39946612747793-Managing-Income-Tax`, `https://help.keka.com/hc/en-us/articles/39946620805265-Managing-taxes-and-deduction-settings-for-a-pay-group` **[DOC]**

**Old vs New regime [DOC]:** documented as *"Old Tax Regime – Higher tax rates but a wide range of deductions. New Tax Regime – Lower tax rates but fewer deductions."*
- **Tax Regime Selection** setting at pay-group level: enable employees to **opt in/out of the new tax regime under Section 115BAC**
- "Managing Income Tax Regime Choices"; "How can an employee change the tax regime?"; "How to check what tax regime an employee is in?"; **"How to set a cut-off date or restrict employees from changing their tax regime?"**
- **"Configuring Tax-Exempt Salary Components under the New Tax Regime in Keka"** — `https://help.keka.com/hc/en-us/articles/39946721916817-...`

**Deduction types covered [DOC]:** Standard Deduction · **Chapter VI-A deductions (Sections 80C to 80U)** · **interest on home loans** · tax-exempt allowances (**HRA, LTA**).

**TDS handling [DOC]:**
- "Managing salary component, contributions, and **TDS overrides**" (`.../39946719976081`)
- "How to override TDS monthly or annually?" · "How to disable TDS for a salary structure" · **"How to make TDS flat deduction for contractual employees?"** · "Why does the payslip say 'TDS/ INCOME TAX MISSING' after TDS overrides?"
- **"Understanding Reasons for Change in Income Tax"** (`.../39946613255825`) — explains month-to-month TDS variance
- **Tax Surge report** exists

**Employee PAN [DOC]:** "Managing Employee PAN details" (`.../39946772618769`) — PAN is also the **payslip password**.

### B5.6 Investment declarations & proof submission
**Sources:** `https://help.keka.com/hc/en-us/articles/39946743856657-Declaring-investments-for-tax-saving`, `.../39946695482641-Configuring-tax-declaration-settings`, `.../43087286925713-Understanding-IT-Declarations-Declared-vs-Approved-Amounts-Status-and-Cut-Off`, `.../39946718427793-Locking-and-Unlocking-IT-Declaration-Proof-Submission`, `.../39946719540881-Approving-or-rejecting-tax-declarations-by-employees` **[DOC]**

**Employee flow:** **My Finances → Manage Tax → Declaration tab** → select category → enter amounts → *"Upload **Proof Documents**, if required"* → save. "My Declarations" view shows what "has been accepted by the payroll team".

**Admin configuration (pay-group Taxes & Deductions tab) [DOC]:**
- **Declaration Due Dates** — monthly window (e.g. 1st–22nd) and financial-year cut-off
- **New Employee Periods** — days after joining within which new joiners may declare (docs elsewhere cite **30 days or by 22 February**)
- **Approval Requirements** — require approval for declaration changes before cut-off
- **Late Submissions** — allow declarations after cut-off, and require approval for them
- **Reminder Emails** — automated notifications to admins and employees
- **Proof Submission** — make proofs mandatory; set proof cut-off date (docs recommend **30+ days after the declaration deadline**)
- **Locking / Unlocking IT Declaration & Proof Submission** — dedicated feature to lock or selectively reopen windows
- **Hiding IT Declarations Section**

**Related operations [DOC]:** "Importing investment declarations in bulk" (`.../39946667250833`) · "How to import IT declarations in bulk?" · "How to approve IT declaration proofs?" · "How to reject an approved investment proof?" · "How can an Admin submit proofs of investments on behalf of the employee?" · "How to download tax declarations?" · "How to get the status report of proof submissions for IT declaration?" (`.../39946625479953`) · "Why are employees not able to declare their investments in Keka?"

**HRA specifics [DOC]:** "How to declare HRA?" · **"How to choose between 'month-on-month' and 'annual' for HRA declarations"** · "How to set the default HRA to Rs.1 lakh" (the PAN-of-landlord threshold) · "How HRA component affects the tax calculation and exemption?" · HRA report · **rent payments and landlord details report** · **lender details report** for home-loan interest · "How to declare interest on housing loan on Keka?" · "How to declare amounts under tax saving allowances?"

**Previous employment [DOC]:** "How to Import Previous salary details?" · "How to download employee's previous employment (income) details report?" · previous employment reports.

### B5.7 Statutory forms & returns
**[DOC]**
| Form | Article |
|---|---|
| **Form 16** (Part A & Part B) | `https://help.keka.com/hc/en-us/articles/39946614310673-Managing-Form-16-for-your-employees` |
| **Form 12BB** | "How to generate Form 12 BB on Keka?" |
| **Form 24Q** (salary TDS quarterly return) | `https://help.keka.com/hc/en-us/articles/39946687266193-Generating-TDS-returns-Form-24Q-for-salaried-employees` |
| **Form 26Q** (non-salary resident TDS — contractors) | `https://help.keka.com/hc/en-us/articles/41860787164433-File-TDS-for-Contractual-Payments-Using-Form-26Q-in-Keka` |
| **Form 27Q** (non-resident TDS) | referenced in the 24Q article as supported |
| PF: Forms 6A, 10, 5, 12A, 3A, ECR | payroll reports |
| ESI: Form 5, monthly returns, ECR | payroll reports |
| PT: monthly / state-wise statements | payroll reports |
| LWF: contribution forms | payroll reports |
| Contract Labour Act 1970 forms | Compliance reports |

**Form 16 workflow [DOC]:**
1. **Download from TRACES** — log in with TAN → Downloads → Form 16 → **KYC validation** (digital signature or normal) → Requested Downloads when "Available" → download **Part A and Part B ZIPs** → convert with **PDF Converter Utility** (password = TAN).
2. **Upload into Keka** — **Payroll → Payroll Admin → Form 16**; upload signed Part A and Part B ZIPs. **File rules: ZIP only; PDF filenames must start with the employee's 10-character PAN matching Keka records.** Optionally upload **Annexure** and **Form 12BA**.
3. **Document Signer App method (Global Admins only)** — log into the **Document Signer App** → "Generate Form 16" → upload Part A ZIP then Part B ZIP → **enable digital signature** if configured → the app **merges and signs** and uploads directly to Keka.

**Form 24Q workflow [DOC]:**
- Prerequisites: **TDS Challans** for the quarter, **CSI file (Challan Status Inquiry)**, company and responsible-person details from the e-Filing portal.
- Path: **Payroll → Payroll Admin → Income Tax & TDS Management**
- **Add challans** per month with: **Minor Head Code, TDS deduction date, challan number, payment date, BSR Code, bank details**
- Generate return files → upload the **CSI file** → enter company details (**TAN, deductor name, PAN**) → responsible person (**name, designation, PAN**) → **generate FVU file** (30–60 seconds) → upload to TRACES → **mark as filed in Keka with token and receipt numbers**
- FAQ: "In form 24Q how to rectify the error 'Payment/Credit/Debited should not to be Zero'?"; "Can we file Tax Returns through Keka?"

**Form 26Q workflow (contractors) [DOC]** — see B10.

### B5.8 Gratuity
**Sources:** `https://help.keka.com/hc/en-us/articles/39946737510929-How-to-enable-gratuity-in-the-F-F-payout`, `https://docs.keka.com/faq/payroll/gratuity/`, `https://help.keka.com/hc/en-us/articles/47058215233425-Gratuity-Calculation-Correction-Support-5-day-6-day-working-days-week` **[DOC]**

- **Eligibility: "at least five years of continuous service"**; gratuity is **employer-funded only** ("Unlike EPF, the employer pays gratuity amount, and employee doesn't have to contribute in gratuity").
- **Two calculation regimes documented:** **covered by the Gratuity Act** (10+ employees) — formula uses **basic pay + dearness allowance with a 15-day multiplier**; **not covered** (<10 employees) — **10-month average salary** basis.
- **Enabled per-exit, inside F&F:** Org → Exits → Exit Process → Exits in Progress → Manage → Finances → Review & Finalise → Page 1 (Payable Components) → **Others** section → tick **"Employee is eligible for gratuity payment"**.
- **5-day vs 6-day working week** is supported in the gratuity denominator (`.../47058215233425`) **[DOC]**
- **GCC variant:** "Gratuity calculation on 365 days" (`.../41208936540177`) and "End of Service Gratuity in GCC Countries" (`.../39946742534033`)
- **Tax exemption:** "How do we calculate the amount of gratuity exempted from tax?" (`https://help.keka.com/hc/en-us/articles/39946690725009-...`)
- Screenshots: `https://help.keka.com/hc/article_attachments/40700086323089`, `40700086323985`, `40700851018769`

### B5.9 Bonus Act, minimum wages, POSH, labour codes
**[DOC]**
- **Labour Codes 2025** — dedicated compliance guide: **"Labour Codes 2025: HR & Payroll Compliance Guide for Keka Users"** — `https://help.keka.com/hc/en-us/articles/41464340017937-Labour-Codes-2025-HR-Payroll-Compliance-Guide-for-Keka-Users`
- **Contract Labour Act 1970 forms** are produced under Compliance Reports **[DOC]**
- **Compliance reports** section covers "statutory compliance, labor acts, and state-specific regulations" **[DOC]**; FAQ "Where to find compliance reports"
- **Minimum wages: [DOC] only for US Payroll** — "Minimum Wage Validation in US Payroll" (`.../39946826536209`). **[UNCERTAIN]** No equivalent Indian minimum-wage validation article was found.
- **Payment of Bonus Act:** **[UNCERTAIN]** — Keka has extensive *discretionary* bonus functionality (bonus types, earned bonus, taxation settings), but I found **no article on statutory Bonus Act 8.33%/20% computation**. Flag for verification — do not assume it exists.
- **POSH:** **[UNCERTAIN]** — **no POSH-specific article found** in Core HR or Payroll help. Any POSH handling would be via Helpdesk categories or policy documents with acknowledgement. Do not claim a POSH module.

---

## B6. Payslips, pay register, payments

### B6.1 Payslips
**Sources:** `https://help.keka.com/hc/en-us/articles/39946667484177-Managing-employees-payslips`, `.../39946693221649-Configuring-payslip-settings-on-Keka`, `.../39946768555409-Configuring-payslip-full-and-final-and-other-important-pay-group-settings` **[DOC]**

**Admin management:** Payroll → Run Payroll → select month → **"Manage Payslip and F&F Statements"** under Payroll Outcome (only for **finalized** months). Multi-select via checkboxes; per-employee actions via three-dot menu. **Persistent release reminders** appear on the payroll outcome screen until all payslips are released.

**Employee access:** **My Finances → My Pay tab → Payslips**; downloadable on web and mobile. **Password = the employee's PAN in uppercase.**

**Payslip settings documented [DOC]:**
- "Append Tax Calculation Summary"
- **YTD totals** or **"Actual Gross"** amounts per component
- "Exclude N/A Payslip Fields"
- Show **loan details, leave summaries, arrear breakups**
- Imported-salary payslip visibility to employees
- Show allowances, **employer contributions**, overtime hours
- **Password protection** toggle (PAN uppercase)
- **Two layout formats:** (1) **3-section** — Earnings / Contributions / Deductions separated; (2) **2-section** — contributions and deductions merged. Fields customisable via **drag-and-drop**.

**Payslip FAQs (each a capability) [DOC]:** customise the payslip · add company logo · **hide a component in the payslip** · change the order of components · update payslip layout · hide/unhide **PF admin/other charges** · hide/unhide **employer PF contribution** · show components marked as outside annual salary · enable actual gross amount · enable/disable password protection · **hold back a payslip after release** · admin download of an individual payslip · **admin bulk payslip download** · hide/unhide the 'My Pay' page from employees.

**Off-cycle payslips [DOC]:** "Understanding Your Payslips: Regular vs. Off-Cycle Payroll in Keka" (`.../39946842907793`)
**F&F statements [DOC]:** "Send full & final statements to employees' personal email addresses" (`.../47983240704273`)

Screenshots: `https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-26-2025-10-20-54-3807-AM.png`, `...10-20-58-2670-AM.png`, `...10-24-50-9491-AM.png`, `...10-32-57-9675-AM.png`, `https://help.keka.com/hc/article_attachments/48523385211665`, `.../44656115738513`; payslip-settings screenshots `.../image-png-Sep-29-2025-08-02-36-4897-AM.png` through `...08-14-27-2670-AM.png`

### B6.2 Pay register
**Source:** `https://help.keka.com/hc/en-us/articles/39946721353361-Customizing-the-Pay-Register-on-Keka` **[DOC]**

- Pay register is **customisable at pay-group level**: add, remove, reorder columns.
- **Two access paths:** Payroll → Settings → Configure → Other Settings → Miscellaneous Settings → Customize Pay Register; **or** Payroll → Run Payroll → View Pay Register → Customize icon.
- **Live preview** before applying.
- **Fixed/protected elements:** Employee Number, Employee Name, Month, Payable, and Salary Components cannot be removed; Employee Details card cannot be removed or repositioned; Remuneration Details and Business Unit can be reordered but not removed; **Perks cannot be configured** in the pay register.
- **Layout changes apply retroactively to all payroll months.**
- Related: "How to check the pay register?" (`https://help.keka.com/admin/admin-help/how-to-check-the-pay-register`); "Pay Register Visibility for Outside CTC Contributions" (`.../47955353405329`); "Why the employee's name is reflecting twice in the pay register?"
- Screenshots: `https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-19-2025-06-52-58-0712-AM.png` and six siblings (`...06-54-28-6398`, `...06-56-44-0916`, `...06-59-15-0722`, `...07-01-39-9759`, `...07-23-02-2013`, `...07-24-06-1910`)

### B6.3 Bank details, payment modes, payment batches
**[DOC]**
- "Viewing and updating employee salary payment modes and bank details" (`.../39946612932625`)
- "How to update the bank details for an employee or in bulk?"
- **"Introducing Employee Bank Verification in Keka"** (`.../39946667920017`) — bank-account verification feature
- **"How to manage payments and download bank statements"** — this is the **bank advice / payment file** function **[DOC]**
- **"How to create a new payment batch?" / "How to create a payment batch?"** — payments are grouped into **batches** **[DOC]**
- **[UNCERTAIN]** Specific bank file formats (ICICI/HDFC/Axis/SBI templates) are not named in any article I could reach. Flag for verification.

### B6.4 Salary payment automation (payout partner)
**Source:** `https://help.keka.com/admin/setting-up-salary-automation` (+ "Processing salary through payment automation", "How is convenience fees for salary disbursal calculated", "FAQ's for salary payment automation") **[DOC]**

- **Status: "This feature is in Beta and available only for select customers."** — important caveat.
- Fund flow: **deposit funds into your disbursal account 1 day prior**; once the balance updates, initiate direct salary payments from Keka.
- *"Payments are processed only after all the approvers in the approval chain have taken action on the request."* Approval chain configured at **Settings → Payment Automation → Update Settings**, supporting multiple levels.
- **KYC required** (private limited): Certificate of Incorporation, MOA, AOA, company PAN, GST certificate, 3-month bank statement or cancelled cheque with IFSC, authorised signatory PAN and government ID. **"typically takes up to 48 hours"**.
- **Convenience fee** is charged for salary disbursal (dedicated FAQ article on how it is calculated).
- **[UNCERTAIN]** The underlying banking/payout partner is not named in the docs I could reach. Flag for verification.

---

## B7. Loans, advances and one-time payments

**Source:** `https://help.keka.com/hc/en-us/articles/39946742065425-Managing-loan-categories-and-loan-policies` **[DOC]**

**Loan categories** — created with **icon, colour, description**. Categories support **interest-free / concessional loan** tracking for tax compliance, **including SBI benchmark rates** (i.e. perquisite valuation on concessional loans).

**Loan policies** define eligibility, approval and repayment:
- **Eligibility criteria:** probation completion or days-from-joining thresholds · **annual salary ranges** · notice-period status
- **Approval chains:** role-based approvers with **auto-approval / skip after X days** of inaction
- **Per-category rules within a policy:**
  - **Interest rate — flat or reducing**
  - **EMI / tenure** — maximum instalment count and commencement period
  - **Loan limits** — fixed amount **or percentage of annual salary**
  - **Documentation** — required attachments/proof
- **Cloning** of policies supported
- **Category-Wise Loan EMI in Payroll** (`.../39946816886033`) — payroll tracks separate instalment amounts by loan type
- "Managing loan policy assignments" (`.../39946712114321`); "Manage ongoing loans" (`.../39946757543441`); "Managing loan requests, repayment and EMIs"

**Loan FAQs (each a capability) [DOC]:** let an employee **skip a loan EMI** for a month · add a loan amount to an individual employee · **add loan amounts in bulk** · how an employee applies for a loan · define a loan category and add a policy · **foreclose a loan** · loan reports · outstanding loan details report (`.../39946666780817`) · assign/unassign a loan policy individually or in bulk · **mark a disbursal loan amount as outside Keka payroll**.

**Leave advance [DOC]:** "Assigning and Managing Leave Advance Policies" (`.../47909086173713`); GCC variant "Enhancing Employee Benefits with Annual Leave Advance in GCC countries".

**Third-party salary advance [DOC]:** **"How to integrate the Fibe (EarlySalary) app with Keka?"** — earned-wage-access / salary advance partner integration.

**One-time (ad-hoc) payments & deductions [DOC]:** added in **Step 4** of the payroll run, individually or via Excel bulk import; "How to add one-time (ad hoc) payments or deductions during payroll processing"; **"How to manage taxation on Ad-hoc Payments/deductions?"**; "How to add Ad-hoc deduction in FnF?"; reports for one-time deductions and payments.

**Other recovery components [DOC]:** Salary Advance Recovery and **Asset Damage Recovery** are named as standard ad-hoc components.

---

## B8. Expenses, reimbursements and travel

**Section:** `https://help.keka.com/hc/en-us/sections/40218008012945-Expense-Travel-Management` **[DOC]**

Full article list:
| Article | URL |
|---|---|
| Overview of Expenses & Travel | `https://help.keka.com/hc/en-us/articles/39946616084625-Overview-of-Expenses-Travel` |
| Overview of Managing Expense and Travel Policies | `https://help.keka.com/hc/en-us/articles/39946778019217-Overview-of-Managing-Expense-and-Travel-Policies` |
| Managing expense & travel policies for your organization | `https://help.keka.com/hc/en-us/articles/39946792111633-Managing-expense-travel-policies-for-your-organization` |
| Creating & Managing Expense & Travel Categories | `https://help.keka.com/hc/en-us/articles/39946746949393-Creating-Managing-Expense-Travel-Categories` |
| Configuring approval chain at expense category level | `https://help.keka.com/hc/en-us/articles/39946601457553-Configuring-approval-chain-at-expense-category-level` |
| Managing Claim Settings | `https://help.keka.com/hc/en-us/articles/39946668276881-Managing-Claim-Settings` |
| Using Advances in Expenses & Travel | `https://help.keka.com/hc/en-us/articles/39946779166865-Using-Advances-in-Expenses-Travel` |
| Understanding Currency Conversions | `https://help.keka.com/hc/en-us/articles/39946778035473-Understanding-Currency-Conversions` |
| Tracking & Managing Your Expenses | `https://help.keka.com/hc/en-us/articles/39946616133649-Tracking-Managing-Your-Expenses` |
| Exploring Travel Desk | `https://help.keka.com/hc/en-us/articles/39946628590609-Exploring-Travel-Desk` |
| Understanding Expenses & Travel Dashboard | `https://help.keka.com/hc/en-us/articles/39946668545809-Understanding-Expenses-Travel-Dashboard` |
| Understanding Expenses & Travel Reports | `https://help.keka.com/hc/en-us/articles/39946737040017-Understanding-Expenses-Travel-Reports` |
| Expense Claim Form | `https://help.keka.com/hc/en-us/articles/39946846350865-Expense-Claim-Form` |

**Documented policy configuration [DOC]:**
- Policy **Name** and short description
- **Base Currency** for expense claims
- **Payout Mode Approval** role assignment
- **Future-Dated Expense Claims** option
- **Approval Chain settings** — multi-level approvals and **category-specific routing**
- Which **expense categories** apply to each policy, plus **category-specific rules and limits**
- **Receipt submission timeframes for cash advances**
- **Approval hierarchies based on expense amount**
- Policies assignable individually and **in bulk**; assigned at employee creation ("Expense Policies" in the add-employee Work Details step)

**Advances [DOC]:** cash advance requests are raised, approved, then **settled against claims**; in **payroll Step 4** admins "Process cash advance requests (approve/reject)" and "Review advance settlements and expense claims for payment".

**Multi-currency [DOC]:** "Understanding Currency Conversions" — expenses support a base currency plus conversions.

**Travel Desk [DOC]:** a distinct module ("Exploring Travel Desk"). **Plan note [DOC]: "Travel Desk" is a Strength-plan feature**; "Expense Management" is Foundation.

**Payroll integration [DOC]:** approved expenses/claims flow into the payroll run at Step 4 and are paid with salary (or separately). "How to change the mode of payment for expenses that are not yet approved?"; "How to download Cost Center-wise Expense report?"

**[UNCERTAIN] — DO NOT ASSUME:**
- **Mileage / per-km rates**, **per diem** rates, and **GST fields on expenses** are **not documented** in any article I could read. The policy article explicitly lacked them. Keka's expense module clearly has category-level limits, but mileage and per-diem as first-class features are **unconfirmed**. Flag for verification.

---

## B9. Off-cycle payroll, holds, F&F

### B9.1 Off-cycle payroll
**Source:** `https://help.keka.com/hc/en-us/articles/39946668015889-Introducing-Off-Cycle-Payroll` **[DOC]**

Definition: *"Off-cycle payroll, also known as ad-hoc payroll, is a payroll process that occurs outside of the regular payroll schedule."*

Documented use cases: termination payouts on the final working day · delayed salaries from a missed regular run · bonuses, commissions and expense reimbursements · emergency financial support.

**Creation steps [DOC]:** Run Payroll → select a **finalized payroll as the base** → **"Run Off-Cycle Payroll"** → select action type → fill off-cycle details → choose eligible employees → review/modify sections (**LOP & reversals, bonuses, salary adjustments, overtime, shift allowances, reimbursements, ad-hoc transactions, overrides**) → "Save and Proceed" → **"lock & continue"** → complete pending activities → view a breakdown of both regular and off-cycle summaries.

Related: **"Understanding Payroll Inputs in Off-Cycle Payroll"** (`.../39946812385681`); **"Post Payroll Actions for Off-Cycle Runs"** (`.../39946785501073`); "Understanding Your Payslips: Regular vs. Off-Cycle Payroll in Keka".

Screenshots: `https://help.keka.com/hc/article_attachments/40463539742737`, `40463560862097`, `40463539751697`, `40463560866065`, `40463560868241`, `40463539763217`, `40463560872977`, `40463539765905`

### B9.2 Salary hold (full and partial)
**[DOC]**
- **Salary processing hold** vs **salary payout hold** — semantics documented in Step 5 (above).
- **Partial Salary Hold** is a distinct feature: "Introduction to Partial Salary Hold Feature" (`.../39946830821137`) and "Navigating the Partial Salary Hold Feature" (`.../39946830930705`).
- FAQs: "How to withhold the salary processing/payout of an employee"; "How to release the salary that has been withheld"; "We do not want to pay salary to an employee or pay 0 net pay, how to do it?"

### B9.3 Full & Final settlement
**Source:** `https://help.keka.com/hc/en-us/articles/39946770277009-Processing-a-Full-and-Final-F-F-Settlement` **[DOC]**

Purpose: *"closing out all dues and deductions accurately to prevent pending payments on either side."*

**Steps [DOC]:**
1. **Access exit record** — Org → Exits tab → Exit Process → Exits in Progress → **Manage**
2. **Open Finances** in the side panel. **Critical prerequisite: "Payroll must be locked for the settlement to proceed smoothly."** → **"Review & Finalise"**
3. **Review payable components** — the system computes and displays six groups:
   - **Leave** — LOP reversals, overrides, arrear LOP, and **leave encashments**
   - **Salary** — salary **arrears**, revisions, bonuses
   - **Others** — **Notice Period Buyouts, Gratuity, Loans, One-Time Payments, and Tax or Contribution Overrides**
   - **Reimbursements & Expenses** — claims, advances, receipts
   - **Attendance** — **overtime and shift allowances**
   - **Assets** — **damage charges**
4. **Choose settlement mode** — (A) **One-Time Complete Settlement**, or (B) **Periodic Partial Settlement** (spread across multiple months, managing each section separately)
5. **Finalize & confirm** — Settlement Status (**Pay it · Void it · Already Paid**); if paying, select **Settlement Month**; **Download F&F Statement**; Finalise → Confirm

**Supporting policies [DOC]:**
- **Notice Period Buyout policies** — `https://help.keka.com/hc/en-us/articles/39946699424401-Managing-Notice-Period-Buyout-policies`; "How to enable notice period buyout in the Full and Final (FnF) settlement"
- **Leave encashment policies** — `https://help.keka.com/hc/en-us/articles/39946693198353-Managing-leave-encashment-policies`; "Where to add the leave encashment formula?"; "How to make leave encashment taxable"; "Exit employee leave encashment tax adjustment procedures"
- **Gratuity** — see B5.8
- F&F FAQs: add ad-hoc deduction in FnF · **override ESI and LWF contributions for an exiting employee** · download the FnF statement · **roll back an F&F settlement** · change the F&F settlement month · Full and Final Settlement Report · view/edit the payables in the FnF process
- **Post-F&F Adjustments for Exited Employees** — `https://help.keka.com/hc/en-us/articles/42594036245137-Post-F-F-Adjustments-for-Exited-Employees` **[DOC]**
- **Initiating Exits and Settlements in Bulk** **[DOC]**
- **Send full & final statements to employees' personal email addresses** (`.../47983240704273`) **[DOC]**

Screenshots (HubSpot CDN, all prefixed `https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/`):
`image-png-Oct-09-2025-06-02-54-4751-AM.png`, `...06-14-46-5994-AM.png`, `...06-25-25-0035-AM.png`, `...06-34-29-4680-AM.png`, `...06-38-19-4849-AM.png`, `...06-41-05-4142-AM.png`, `...06-43-25-7247-AM.png`, `...06-44-29-3583-AM.png`

---

## B10. Contractors / consultants and their TDS

**Source:** `https://help.keka.com/hc/en-us/articles/41860787164433-File-TDS-for-Contractual-Payments-Using-Form-26Q-in-Keka` **[DOC]**

- Keka manages **TDS on payments to vendors, contractors and professionals** via **Form 26Q**.
- Documented capabilities: "Track TDS deducted through Keka" · **add external TDS data for payments made outside the system** · "Manage challans and map payees" · generate quarterly **Form 26Q files in FVU and text formats** · maintain **generation history** for compliance.
- **Contractual payments processed in Keka are automatically considered** for TDS without manual intervention.
- For payments made outside Keka, admins enter: **payee name and PAN, nature of payment, payment and TDS amounts with dates**; **bulk import** available.
- **Filing workflow:** Payroll Admin → **TDS Management (24Q & 26Q)** → Form 26Q → select **legal entity, financial year, quarter** → review monthly deductions across the two sources → **map all TDS entries to challans** → generate return files using **CSI** data from the bank portal → download **.txt** or **.ZIP (FVU)** for the Income Tax portal.
- Related: **"How to make TDS flat deduction for contractual employees?"** **[DOC]**
- **Core HR side [DOC]:** "Managing Contract Workers" and "Creating & Managing Worker Types" articles exist — contractors are modelled as a worker type.
- **US side [DOC]:** "Understanding Fixed Compensation for Contractors in Keka" (`.../44654657089681`); "Tax Documents for Employees and Contractors (US Payroll)" (`.../39946793012241`, `.../39946865063825`) — i.e. **1099 handling for US contractors**.
- **[UNCERTAIN]** Specific TDS sections (194C, 194J) are not named in the article text I retrieved, though "nature of payment" selection implies section mapping. Flag for verification.

---

## B11. Multi-entity, multi-state, multi-country

### Multiple legal entities **[DOC]**
- **"Payroll for Multiple Legal Entities" is an explicit Foundation-plan feature** on the pricing page.
- Statutory filing details (PAN, TAN, PF, ESI, PT, LWF registrations + authorised signatories) are held **per pay group**, and pay groups map to legal entities.
- Form 24Q/26Q generation is **selected by legal entity**.
- Document templates can be **scoped to specific legal entities**.
- FAQs: "Why the updated Legal entity details are not reflecting in payslip?"; "How to view/update the Company Identification Number (CIN) in Keka?"

### Multiple states **[DOC]**
- **PT** and **LWF** registrations are held **per state** with an Establishment ID, registration date, signatory, and a list of **linked office locations** that follow the same rules — this is how Keka handles multi-state operation.
- State-specific PT logic is implemented (e.g. Tamil Nadu corporation vs panchayat; half-yearly vs monthly PT on exit).

### Multi-currency and global payroll **[DOC]**
**Keka does not market a product called "Keka Global"** in anything I could verify. What is documented:

| Region | Evidence |
|---|---|
| **India** | The core payroll product; entire statutory stack (PF/ESI/PT/LWF/TDS/Form 16/24Q/26Q/gratuity) |
| **United States** | Dedicated **US Payroll** help section with **30 articles**: federal/state tax filing, **garnishments and post-tax deductions**, **check printing**, tax form delivery method, **benefits enrolment**, **HSA coverage types**, **401(k)-style additional benefit types**, **2% shareholder benefit reporting**, **$100K federal tax liability rule**, **minimum wage validation**, **multiple pay rates**, **piece-rate compensation & OT**, **pay stub configurations**, Tax Filing Section, **QuickBooks integration**, **transactions report**, contractor fixed compensation, tax documents for employees and contractors. A separate site exists at `https://www.keka.com/us/payroll-software`. Reviewers state coverage of **all 50 states** **[REVIEW]**. |
| **UAE / GCC** | Dedicated **AE Payroll** help section with **11 articles**: **End of Service Gratuity in GCC**, **Social Insurance Contributions for GCC Countries**, **GCC Social Insurance updates for Oman and Saudi Arabia**, **DEWS contributions (DIFC Free Zone)**, **Air Ticket benefits** (incl. multi-year claims and last-claim date), **Sick Leave Payment for GCC**, **Annual Leave Advance in GCC**, gratuity on 365 days, fixed LOP deduction based on annual salary. So: **UAE (incl. DIFC), Oman, Saudi Arabia** are explicitly named. |

- **Multi-currency**: documented for **expenses** ("Understanding Currency Conversions") and a **Base Currency** per expense policy. **[UNCERTAIN]** whether payroll itself is multi-currency beyond the US/AE localisations.
- **Regional marketing sites confirm three payroll geographies [DOC]:**
  - India — `https://www.keka.com/` (default site)
  - United States — `https://www.keka.com/us/` and `https://www.keka.com/us/payroll-software`
  - UAE — `https://www.keka.com/ae/payroll-processing`, titled **"WPS-Ready Payroll Processing Software for UAE"**, i.e. Keka supports the UAE **Wage Protection System (WPS)** file format. **[UNCERTAIN]** — the WPS claim comes from that page's title as returned by search; the page body was not fetched. Verify.
- **[REVIEW]** One reviewer states native payroll support is **unverified for UK, Canada, Australia and Germany**, describing this as a gap for globally expanding organisations (`https://www.hr.software/reviews/keka`).
- **[UNCERTAIN]** `https://www.keka.com/global-companies` exists but was robots-blocked to automated fetch; its country claims could not be verified.

---

## B12. Accounting / ERP integrations and JV export

**[DOC]**

| System | Evidence |
|---|---|
| **Zoho Books** | Full article: `https://help.keka.com/hc/en-us/articles/39946770475153-Accounting-Integration-with-Zoho-Books`. Marketplace app "Zoho Books for Payroll". |
| **Tally** | "How to integrate Tally with Keka?" (`https://help.keka.com/admin/admin-help/how-to-integrate-tally-with-keka`). Marketplace app **"Tally for Payroll"**. |
| **QuickBooks** | `https://help.keka.com/hc/en-us/articles/43055995694353-Quickbook-Integeration` (US Payroll section). Marketplace app "QuickBooks for Invoicing". Also detailed in the third-party integration article with two scenarios: payroll processed in Keka with QuickBooks handling disbursement; or payroll managed in QuickBooks with Keka as the employee/salary record system. |
| **NetSuite** | Referenced as having "a Keka Integration Guide". |
| **SAP** | Referenced article "Keka–SAP Integration Guide: Key Learnings from Real Implementations". **[UNCERTAIN]** — appears to be a services/implementation guide rather than a packaged connector. |
| **ProcessWare** | "Keka Integration with ERP Tool (ProcessWare)". |
| **Xero** | Marketplace app "Xero for Keka PSA" (PSA/invoicing, not payroll GL). |
| **Oracle** | **[UNCERTAIN] — no evidence found.** Do not claim an Oracle integration. |

**Journal voucher / GL export [DOC]** (from the Zoho Books article, which is the fullest account of the JV mechanism):
- Path: **Payroll → Payroll Admin → Accounting** → Integrations
- **Map salary components to accounts as debit or credit entries**; requirement: *"the sum of debit and credit entries should match"* for successful posting
- After payroll is finalised each month, **generate journal vouchers** including processed salary components and cumulative totals
- **Export directly** (Zoho Books: Accountant → Manual Journal) **or download as XLSX**
- If payroll is **rolled back or re-finalised**, regenerate and re-export; previous versions move to **Archives**
- **JVs cannot be deleted after export, only regenerated**; changing the mapped organisation removes previous account mappings
- A **"Payroll journal vouchers"** report is listed under Payroll Run Reports
- Tally flow: **Apps → Tally → Setup**, then Payroll Admin → Accounting → Integrations, **mapping Keka components to their corresponding Tally names**

**API [DOC]:** `developers.keka.com` — documented integration scope includes "Retrieving employee data and financial details, accessing salary structures and **finalized pay registers**, managing ad-hoc payments and salary revisions."

Screenshots (Zoho Books): `https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-30-2025-11-54-58-1622-AM.png`, `.../image-png-Oct-01-2025-05-59-47-0654-AM.png`, `.../image-png-Oct-01-2025-06-20-02-2352-AM.png`

---

## B13. Payroll reports — the full list

**Source:** `https://help.keka.com/admin/using-payroll-reports-on-keka` (the `/hc/` mirror renders this list as an image only; the legacy page has it as text) **[DOC]**

### Payroll Reports
- Current salary structures
- Bonuses and bonus status
- Perk details
- Annual total compensation
- Financial information related to salaries
- Salary revision records

### Payroll Run Reports
- Component-by-component payroll comparison per employee
- **Pay registers**
- Monthly and annual cost breakdowns
- Earned bonus reports
- **Arrears reports**
- Contribution/deduction reconciliations
- Group-wise summaries
- **Payroll journal vouchers**
- One-time deductions and payments
- Overtime reports
- Shift allowances

### Component Claim Reports
- Component claims with status tracking (paid/pending)
- Accumulated amounts by component

### YTD Reports
- Total salaries for all employees
- Overall gross earnings
- **Total TDS**
- Total PF contributions
- Month-on-month employee reports

### Income Tax Reports
- Annual income tax reports (standard and **detailed**)
- **HRA reports**
- Investment declarations (**detailed, summary, breakdown**)
- **Proof submission reports**
- **Monthly income tax statements**
- **Rent payments and landlord details**
- **Lender details** and **previous employment** reports
- **TDS overrides** and **Tax Surge** reports

### PF Statutory Forms
- **Form 6A, Form 10, Form 5, Form 12A, Form 3A**
- PF remittance details
- **Monthly ECR**
- Administrative charges
- Arrears

### ESI Statutory Forms
- ESI monthly statements and **overrides**
- ESI summary reports
- **ESI monthly returns**
- **Form 5**

### Professional Tax Reports
- Monthly PT statements
- **State-wise PT reports**
- PT overrides

### LWF Statutory Forms
- LWF contribution forms

### Loan Reports
- Loan requests and monthly EMI
- Loan status and **outstanding balances**
- (Exported files include **Employee Number**)

### Full and Final Settlement Reports
- Settlement records by date range

### Compliance Reports
- Statutory compliance, labour acts and state-specific regulations
- **Contract Labour Act (1970) forms**

### Payroll analytics (separate from reports)
- **Compensation Planning**
- **Estimating Compensation Budgets**
- **Compare Compensation Cost**
- **Comparing Employee Competitiveness**
- **Geographical Differentials** tab in Payroll Analytics
- "How to check the Payroll details for Upcoming Months for Budgeting?"

### Payroll audit
- **Audit Logs for Employees' Finance** — `https://help.keka.com/hc/en-us/articles/39946613202321-Audit-Logs-for-Employees-Finance`

---

# PART C — PLAN / PACKAGING MAPPING

**Source:** `https://www.keka.com/pricing` **[DOC]**

Keka's HR & Payroll platform uses **three plan tiers: Foundation → Strength → Growth** (each is cumulative — Strength includes all Foundation, Growth includes all Strength). The "Essential/Growth/Scale" naming in the brief does **not** match Keka's current public pricing page; **PSA** uses *Basic / Advance / Scale*, and **Keka Hire** uses *Pro / Advanced*. That is likely the source of the confusion.

**Pricing note:** the pricing page's numeric values did not render to the fetcher (shown as "$/month (up to employees); per additional employee"). Keka's India pricing is typically a **base monthly fee covering up to N employees plus a per-additional-employee rate**, but exact figures could not be confirmed here. **[UNCERTAIN] — verify prices directly.**

## Foundation plan — "For companies that are just getting started with automation"
- Interactive Employee Profile
- **Document Storage & Generation**
- **Employee Onboarding**
- **Standard Access Roles**
- Dashboards and Analytics
- **Employee Life Cycle Tracker**
- Advanced Leave Management
- Gamified Attendance System
- Overtime Automation
- **Payroll Automation**
- **Statutory Compliance**
- **Accounting Integration**
- **Loan Tracking**
- **Benefits Tracking**
- **Expense Management**
- **Employee Tax Management**
- Email signup and mobile app access
- Notification Center
- **Payroll for Multiple Legal Entities**
- Advanced Shift Scheduler
- Timesheet
- **API & Webhooks**
- **Helpdesk**

## Strength plan — "Scaling with advanced automation & employee engagement"
*All Foundation, plus:*
- **Employee Timeline Plus**
- **Employee Onboarding Plus**
- **Employee Exit Surveys**
- **Travel Desk**
- **Asset Tracking**
- **Advanced Roles & Permissions**
- **Custom Notifications**
- **Slack and MS Teams integration**
- **Custom Reports Builder**
- GPS/Selfie Attendance
- Continuous Location Punching
- **Single Sign-On**
- Login Using Mobile OTP

## Growth plan — "Align employees in your growth journey and get their best"
*All Strength, plus:*
- Employee Pulse Surveys
- One-One Meeting
- Continuous Feedback
- **Public Praise**
- **Employee Expression Wall**
- Cyclic Performance Reviews
- Performance Analytics
- Skill Matrix
- Bands and Calibration
- Performance declaration
- SMART Goal Setting Engine
- Goals Monitoring
- Goals Alignment
- OKRs
- Performance Improvement Plan
- Training Need Identification
- **People Analytics**

## Separately priced
- **Keka Learn** — LMS bundled with HRMS (add-on)
- **Keka Rewards** — recognition/rewards platform (add-on)
- **PSA** (requires an HR & Payroll plan): **PSA Basic** (project time tracking, timesheet rules, expense tracking, manager approvals, project administration) → **PSA Advance** (+ resource planning, allocation tracking, project health dashboards, billing automation, skill tracking) → **PSA Scale** (+ sales pipeline, revenue forecasting, budget tracking, client portal)
- **Keka Hire** (requires an HR & Payroll plan), priced **per recruiter**: **Pro** (up to 10 active jobs, career portal, requisition management, interview scheduling and scorecards, candidate engagement and portal, offer letters and pre-joining workflows) → **Advanced** (+ unlimited job postings, offer approval process, custom roles/permissions, internal job board)

## Plan mapping for the specific features in this brief

| Feature | Plan **[DOC]** |
|---|---|
| Employee profile, custom fields, org structure | Foundation |
| Employee onboarding | Foundation ("Employee Onboarding"); enhanced in Strength ("Employee Onboarding Plus") |
| Document storage & letter generation | Foundation |
| Employee life cycle tracker | Foundation |
| Employee timeline | Foundation basic; "Employee Timeline **Plus**" = Strength |
| **Exit surveys** | **Strength** |
| **Asset tracking** | **Strength** |
| **Helpdesk** | **Foundation** (though the helpdesk overview article calls it "an add-on feature" — **[UNCERTAIN]**, reconcile) |
| Expense management | Foundation |
| **Travel Desk** | **Strength** |
| Payroll automation, statutory compliance, employee tax management | Foundation |
| **Payroll for multiple legal entities** | **Foundation** |
| Accounting integration (Zoho Books / Tally / QuickBooks) | Foundation |
| Loan tracking, benefits tracking | Foundation |
| Standard roles | Foundation; **Advanced Roles & Permissions = Strength** |
| SSO, Slack/Teams, custom notifications, custom report builder | **Strength** |
| Praise wall / expression wall / pulse surveys / people analytics | **Growth** |

**[UNCERTAIN] — plan placement NOT documented on the pricing page** for these specific payroll sub-features: off-cycle payroll, maker-checker payroll approval workflow, partial salary hold, salary payment automation (stated to be **Beta / select customers only**), US Payroll, AE/GCC Payroll, Form 26Q contractor TDS, compensation planning/benchmarking analytics. Treat their plan mapping as unknown.

---

# PART D — HELP-CENTRE ARTICLES CONTAINING PRODUCT SCREENSHOTS

Confirmed by inspecting the pages: each of these articles embeds real product screenshots.

| # | Article title | URL | Screenshots |
|---|---|---|---|
| 1 | **Running payroll on Keka** (the 6 steps) | `https://help.keka.com/hc/en-us/articles/39946563404561-Running-payroll-on-Keka` | 6 (one per step) |
| 2 | Creating and configuring a new pay group | `https://help.keka.com/hc/en-us/articles/39946630038673-Creating-and-configuring-a-new-pay-group` | 16 |
| 3 | Creating and managing salary structures for a pay group | `https://help.keka.com/hc/en-us/articles/39946778678289-Creating-and-managing-salary-structures-for-a-pay-group` | 21 + 2 GIFs |
| 4 | Processing a Full and Final (F&F) Settlement | `https://help.keka.com/hc/en-us/articles/39946770277009-Processing-a-Full-and-Final-F-F-Settlement` | 8 |
| 5 | Introducing Off-Cycle Payroll | `https://help.keka.com/hc/en-us/articles/39946668015889-Introducing-Off-Cycle-Payroll` | 8 |
| 6 | Approval Workflow (Maker-Checker) for Payroll Finalisation | `https://help.keka.com/hc/en-us/articles/41388353533073-Approval-Workflow-Maker-Checker-for-Payroll-Finalisation` | 11 |
| 7 | Creating a New Helpdesk Category (SLA & escalation screens) | `https://help.keka.com/hc/en-us/articles/48866672049681-Creating-a-New-Helpdesk-Category` | 11 |
| 8 | Managing Helpdesk Settings | `https://help.keka.com/hc/en-us/articles/39946725231249-Managing-Helpdesk-Settings` | 3 |
| 9 | Customizing the Pay Register on Keka | `https://help.keka.com/hc/en-us/articles/39946721353361-Customizing-the-Pay-Register-on-Keka` | 7 |
| 10 | Configuring payslip, full and final and other important pay group settings | `https://help.keka.com/hc/en-us/articles/39946768555409-Configuring-payslip-full-and-final-and-other-important-pay-group-settings` | 6 |
| 11 | Managing employees' payslips | `https://help.keka.com/hc/en-us/articles/39946667484177-Managing-employees-payslips` | 6 |
| 12 | Managing Labour Welfare Fund (LWF) contribution settings for a pay group | `https://help.keka.com/hc/en-us/articles/39946712012433-Managing-Labour-Welfare-Fund-LWF-contribution-settings-for-a-pay-group` | 3 |
| 13 | Managing the ESI contributions for a pay group | `https://help.keka.com/hc/en-us/articles/39946725885073-Managing-the-Employees-State-Insurance-ESI-contributions-for-a-pay-group` | 3 |
| 14 | Managing IT, PF, LWF, Professional Tax, and ESI filing details for the pay group | `https://help.keka.com/hc/en-us/articles/39946667222161-Managing-IT-PF-LWF-Professional-Tax-and-ESI-filing-details-for-the-pay-group` | 3+ |
| 15 | Understanding Tax-Saving Reimbursements | `https://help.keka.com/hc/en-us/articles/39946778649489-Understanding-Tax-Saving-Reimbursements` | 3 |
| 16 | Accounting Integration with Zoho Books | `https://help.keka.com/hc/en-us/articles/39946770475153-Accounting-Integration-with-Zoho-Books` | 3 |
| 17 | How to setup an employee number series on Keka? | `https://help.keka.com/hc/en-us/articles/39946565641745-How-to-setup-an-employee-number-series-on-Keka` | 4 |
| 18 | How to enable gratuity in the F&F payout? | `https://help.keka.com/hc/en-us/articles/39946737510929-How-to-enable-gratuity-in-the-F-F-payout` | 3 |
| 19 | Initiating Onboarding for Employees | `https://help.keka.com/hc/en-us/articles/39946653303441-Initiating-Onboarding-for-Employees` | 3 + Vimeo video |
| 20 | Initiating the Exit Process | `https://help.keka.com/hc/en-us/articles/39946630255761-Initiating-the-Exit-Process` | 2 |
| 21 | Overview - Roles & Permissions | `https://help.keka.com/hc/en-us/articles/39946719445393-Overview-Roles-Permissions` | 1 |
| 22 | Creating and Managing Document Templates | `https://help.keka.com/hc/en-us/articles/39946772476817-Creating-and-Managing-Document-Templates` | 2+ |
| 23 | Managing Employee Documents | `https://help.keka.com/hc/en-us/articles/39946717792145-Managing-Employee-Documents` | multiple |
| 24 | Managing Income Tax (old vs new regime comparison chart) | `https://help.keka.com/hc/en-us/articles/39946612747793-Managing-Income-Tax` | 1 |
| 25 | Using Payroll Reports on Keka (report catalogue as an image) | `https://help.keka.com/hc/en-us/articles/39946740064913-Using-Payroll-Reports-on-Keka` | 1 |
| 26 | Managing Form 16 for your employees (TRACES + Keka + Document Signer App) | `https://help.keka.com/hc/en-us/articles/39946614310673-Managing-Form-16-for-your-employees` | multiple |
| 27 | Generating TDS returns (Form 24Q) for salaried employees | `https://help.keka.com/hc/en-us/articles/39946687266193-Generating-TDS-returns-Form-24Q-for-salaried-employees` | GIF walkthroughs |
| 28 | Managing salary components (3-step setup diagram) | `https://help.keka.com/hc/en-us/articles/39946721937681-Managing-salary-components` | 1 diagram |

## Direct image URLs of official Keka product screenshots

Keka serves help-centre images from **two** CDNs:
- Zendesk attachments: `https://help.keka.com/hc/article_attachments/<numeric-id>`
- HubSpot (migrated content): `https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/<filename>`

### Payroll run — the 6 steps (one screenshot per step)
```
https://help.keka.com/hc/article_attachments/40555431635345   # Step 1 Leave, Attendance & Daily Wages
https://help.keka.com/hc/article_attachments/40555411317393   # Step 2 New Joinees & Exits
https://help.keka.com/hc/article_attachments/40555411327761   # Step 3 Bonus, Salary Revisions & Overtime
https://help.keka.com/hc/article_attachments/40555411333905   # Step 4 Reimbursements, Ad-hoc Payments, Deductions
https://help.keka.com/hc/article_attachments/40555411343633   # Step 5 Salary on Hold & Arrears
https://help.keka.com/hc/article_attachments/40555411347601   # Step 6 Overrides & Finalizing Payroll
```

### Pay group configuration (16)
```
https://help.keka.com/hc/article_attachments/40554214949521
https://help.keka.com/hc/article_attachments/40554184072721
https://help.keka.com/hc/article_attachments/40554214950033
https://help.keka.com/hc/article_attachments/40554214951057
https://help.keka.com/hc/article_attachments/40554184074385
https://help.keka.com/hc/article_attachments/40554184075153
https://help.keka.com/hc/article_attachments/40554184077073
https://help.keka.com/hc/article_attachments/40554214953361
https://help.keka.com/hc/article_attachments/40554184077969
https://help.keka.com/hc/article_attachments/40554214954769
https://help.keka.com/hc/article_attachments/40554214955409
https://help.keka.com/hc/article_attachments/40554214956305
https://help.keka.com/hc/article_attachments/40554184082449
https://help.keka.com/hc/article_attachments/40554184083089
https://help.keka.com/hc/article_attachments/40554214959249
https://help.keka.com/hc/article_attachments/40554184086289
```

### Salary structures (21)
```
https://help.keka.com/hc/article_attachments/40542561554449
https://help.keka.com/hc/article_attachments/40542561554961
https://help.keka.com/hc/article_attachments/40542592067729
https://help.keka.com/hc/article_attachments/40542592068881
https://help.keka.com/hc/article_attachments/40542561558161
https://help.keka.com/hc/article_attachments/40542561560209
https://help.keka.com/hc/article_attachments/40542592070417
https://help.keka.com/hc/article_attachments/40542561560977
https://help.keka.com/hc/article_attachments/40542561562129
https://help.keka.com/hc/article_attachments/40542561562769
https://help.keka.com/hc/article_attachments/40542592075921
https://help.keka.com/hc/article_attachments/40542592076305
https://help.keka.com/hc/article_attachments/40542561564945
https://help.keka.com/hc/article_attachments/40542592078225
https://help.keka.com/hc/article_attachments/40542561569297
https://help.keka.com/hc/article_attachments/40542561569553
https://help.keka.com/hc/article_attachments/40542592081041
https://help.keka.com/hc/article_attachments/40542592081553
https://help.keka.com/hc/article_attachments/40542592082705
https://help.keka.com/hc/article_attachments/40542561575441
```

### Off-cycle payroll (8)
```
https://help.keka.com/hc/article_attachments/40463539742737
https://help.keka.com/hc/article_attachments/40463560862097
https://help.keka.com/hc/article_attachments/40463539751697
https://help.keka.com/hc/article_attachments/40463560866065
https://help.keka.com/hc/article_attachments/40463560868241
https://help.keka.com/hc/article_attachments/40463539763217
https://help.keka.com/hc/article_attachments/40463560872977
https://help.keka.com/hc/article_attachments/40463539765905
```

### Maker-checker payroll approval workflow (11)
```
https://help.keka.com/hc/article_attachments/41388364330257
https://help.keka.com/hc/article_attachments/41388353518097
https://help.keka.com/hc/article_attachments/41388353518993
https://help.keka.com/hc/article_attachments/41388364335633
https://help.keka.com/hc/article_attachments/41388364336529
https://help.keka.com/hc/article_attachments/41388364337297
https://help.keka.com/hc/article_attachments/41388364339345
https://help.keka.com/hc/article_attachments/41388364340753
https://help.keka.com/hc/article_attachments/41388364341905
https://help.keka.com/hc/article_attachments/41388364343057
https://help.keka.com/hc/article_attachments/41388364344593
```

### Helpdesk category / SLA / escalation (11) + settings (3)
```
https://help.keka.com/hc/article_attachments/48866610732817
https://help.keka.com/hc/article_attachments/48866610733713
https://help.keka.com/hc/article_attachments/48866610734865
https://help.keka.com/hc/article_attachments/48866672028049
https://help.keka.com/hc/article_attachments/48866672028945
https://help.keka.com/hc/article_attachments/48866672030609
https://help.keka.com/hc/article_attachments/48866672031121
https://help.keka.com/hc/article_attachments/48866672035473
https://help.keka.com/hc/article_attachments/48866672036241
https://help.keka.com/hc/article_attachments/48866610740753
https://help.keka.com/hc/article_attachments/48866672038801
https://help.keka.com/hc/article_attachments/45609238874769   # Helpdesk Settings tab
https://help.keka.com/hc/article_attachments/48937273600273   # Add Category screen
https://help.keka.com/hc/article_attachments/45609275515665   # Canned Responses
```

### Statutory settings, employee number series, gratuity, onboarding
```
https://help.keka.com/hc/article_attachments/40344254387985   # ESI settings
https://help.keka.com/hc/article_attachments/40344284738065   # ESI settings
https://help.keka.com/hc/article_attachments/40344284738833   # ESI settings
https://help.keka.com/hc/article_attachments/40488262487569   # IT filing details form
https://help.keka.com/hc/article_attachments/40488262493329   # PF filing details
https://help.keka.com/hc/article_attachments/40488262511377   # LWF state window
https://help.keka.com/hc/article_attachments/40643329060625   # Employee number series config
https://help.keka.com/hc/article_attachments/40643345645329   # Employee number series edit
https://help.keka.com/hc/article_attachments/40643345649809   # Add new series dialog
https://help.keka.com/hc/article_attachments/40643345651089   # Series preview
https://help.keka.com/hc/article_attachments/40700086323089   # Gratuity in F&F
https://help.keka.com/hc/article_attachments/40700086323985   # Gratuity in F&F
https://help.keka.com/hc/article_attachments/40700851018769   # Gratuity in F&F
https://help.keka.com/hc/article_attachments/40247577515537   # Onboarding tasks tab
https://help.keka.com/hc/article_attachments/40247577518865   # Onboarding initiation
https://help.keka.com/hc/article_attachments/40247561334033   # Skip onboarding
https://help.keka.com/hc/article_attachments/40699867885201   # Roles & Permissions screen
https://help.keka.com/hc/article_attachments/48523385211665   # Payslip management
https://help.keka.com/hc/article_attachments/44656115738513   # Payslip management
```

### HubSpot-hosted screenshots
```
# Full & Final settlement (8)
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Oct-09-2025-06-02-54-4751-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Oct-09-2025-06-14-46-5994-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Oct-09-2025-06-25-25-0035-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Oct-09-2025-06-34-29-4680-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Oct-09-2025-06-38-19-4849-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Oct-09-2025-06-41-05-4142-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Oct-09-2025-06-43-25-7247-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Oct-09-2025-06-44-29-3583-AM.png

# Pay register customisation (7)
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-19-2025-06-52-58-0712-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-19-2025-06-54-28-6398-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-19-2025-06-56-44-0916-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-19-2025-06-59-15-0722-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-19-2025-07-01-39-9759-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-19-2025-07-23-02-2013-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-19-2025-07-24-06-1910-AM.png

# Payslip settings (6)
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-29-2025-08-02-36-4897-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-29-2025-08-06-10-2410-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-29-2025-08-09-57-8274-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-29-2025-08-10-52-4546-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-29-2025-08-12-12-0440-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-29-2025-08-14-27-2670-AM.png

# Payslip management (4)
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-26-2025-10-20-54-3807-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-26-2025-10-20-58-2670-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-26-2025-10-24-50-9491-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-26-2025-10-32-57-9675-AM.png

# LWF settings (3)
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Oct-01-2025-07-05-02-6466-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Oct-01-2025-07-26-45-6532-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Oct-01-2025-07-28-49-0186-AM.png

# Tax-saving reimbursements (3)
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-30-2025-10-25-02-1308-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-30-2025-10-37-28-8876-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-30-2025-10-39-59-9258-AM.png

# Zoho Books accounting integration (3)
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Sep-30-2025-11-54-58-1622-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Oct-01-2025-05-59-47-0654-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Oct-01-2025-06-20-02-2352-AM.png

# Exit initiation (2)
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Oct-06-2025-11-48-12-6180-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/df-jpg.jpeg

# Document templates (2)
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/image-png-Oct-03-2025-04-32-00-5696-AM.png
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/q%20(31).jpg

# Diagrams / infographics
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/6UfWdD46HAyrw-DLGAoEbGIK2weSHCp0mg.png   # Salary component 3-step setup
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/Shivi_roughcopy%20(2).png                # "Different Payroll Reports on Keka" catalogue
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/Shivi_roughcopy%20(3).png                # Old vs New Tax Regime comparison

# Animated GIFs in the salary-structures article
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/Knowledge%20Base%20Import/s3-ap-south-1.amazonaws.comind-cdn.freshdesk.comdatahelpdeskattachmentsproduction84028730576originalyy_tUDDYWATKcPvQ5Xs43rx_Am-W5DXTQg-1.gif
https://3947363.fs1.hubspotusercontent-na1.net/hubfs/3947363/Knowledge%20Base%20Import/s3-ap-south-1.amazonaws.comind-cdn.freshdesk.comdatahelpdeskattachmentsproduction84028780186originalznkIgvGURgSFSMV2WxF_sVwnuoxjcsjGDA-1.gif
```

**Video assets [DOC]:** several help articles embed Vimeo walkthroughs (e.g. onboarding initiation `player.vimeo.com/video/933680213`); there is a **Video Academy** category at `https://help.keka.com/hc/en-us/categories/39012933183249-Video-Academy`, plus YouTube "Processing Payroll in 6 Simple Steps l Keka HR" (`https://www.youtube.com/watch?v=7Iux49bD6ZM`).

---

# PART E — WHAT IS UNCERTAIN OR UNVERIFIED (do not state as fact)

1. **Org chart** — no help article located describing an org-chart visualisation. Marketing/reviewers mention it; Keka docs I reached do not.
2. **Secondary / dotted-line reporting managers** — not documented in the add-employee or org-structure articles. Only a single "Reporting Manager" field is documented, plus implicit Department Head / Business Head roles and "indirect reportees" ("Who are Indirect reportee and how can a manager view indirect reportee's data?" — this implies a hierarchy roll-up, not a dotted line). **Do not claim dotted-line reporting.**
3. **Employee directory** — no dedicated article; likely served by employee search + visibility settings.
4. **Appointment letter / experience letter** as pre-built letter types — docs name only offer, confirmation and relieving letters; others would be custom templates.
5. **Dedicated promotion/transfer workflow** — not found; handled as effective-dated job-detail changes plus salary revisions.
6. **PF numeric parameters** (₹15,000 ceiling, 12%, EPS 8.33%, EDLI, admin charges %) — implemented in product but not spelled out in the articles reachable here.
7. **Which Indian states' PT slabs and LWF rules are pre-loaded** — not enumerated anywhere in the docs.
8. **Payment of Bonus Act (statutory 8.33%–20% bonus)** — **no article found**. Keka has discretionary bonus features, not confirmed statutory Bonus Act computation.
9. **Minimum wages for India** — only US minimum-wage validation is documented.
10. **POSH** — no POSH-specific module or article found.
11. **Mileage rates, per-diem, and GST on expenses** — not documented. Do not assume.
12. **Bank file formats / named banking partner for salary payment automation** — not named; the feature itself is **Beta, select customers only**.
13. **Oracle integration** — no evidence at all.
14. **SAP** — only an implementation "key learnings" guide is referenced, not a packaged connector.
15. **"Keka Global"** — no such product name verified. Keka has India + **US Payroll** + **AE/GCC Payroll** (UAE incl. DIFC, Oman, Saudi Arabia named). `www.keka.com/global-companies` exists but was not fetchable.
16. **Exact plan pricing numbers** — did not render; verify on the live pricing page.
17. **Helpdesk: "add-on" vs Foundation-plan inclusion** — the product doc and the pricing page appear to disagree.
18. **Compensation Planning** article content — video-only in the version fetched; budget/increment-letter specifics unverified.
19. **Exit survey anonymity and question types** — not documented.
20. **Whether an employee-number series can be scoped per legal entity** — only "multiple series" is documented.

## What reviewers claim (NOT Keka documentation) — **[REVIEW]**
From `https://www.hr.software/reviews/keka`:
- Strength: a single subscription unifying core HR, payroll, performance and ATS; public per-employee pricing for core modules; "deep statutory compliance across US (50 states), India, and UAE markets".
- Limitation: "occasional lagging and attendance sync issues, particularly with the mobile app".
- Limitation: "overly complex for very small teams" (<10 employees).
- Limitation: native payroll support **unverified** for UK, Canada, Australia, Germany.
- Limitation: PSA and Hiring modules require custom quotes rather than transparent pricing.

Other reviewer sources exist (G2, Capterra, hrone.cloud, peoplemanagingpeople.com, hrstacks.com) — note that **hrone.cloud is a direct competitor** publishing "switching from Keka" content, so treat its claims as adversarial marketing, not neutral review.

---

# SOURCES

## Help-centre indexes
- Keka Help Center home — https://help.keka.com/
- Admin Help Center (all sections) — https://help.keka.com/hc/en-us/categories/38988972316305-Admin-Help-Center
- Employee & Manager Guide — https://help.keka.com/hc/en-us/categories/39012710241041-Employee-Manager-Guide
- Video Academy — https://help.keka.com/hc/en-us/categories/39012933183249-Video-Academy
- Core HR section — https://help.keka.com/hc/en-us/sections/39010982224913-Core-HR
- Core HR (legacy index, richest) — https://help.keka.com/admin/core-hr
- Core HRMS FAQs — https://help.keka.com/hc/en-us/sections/39012212530065-Core-HRMS-FAQs
- Payroll section — https://help.keka.com/hc/en-us/sections/39011023299729-Payroll
- **Payroll (legacy index, richest — 100+ FAQ titles)** — https://help.keka.com/admin/payroll
- Payroll setup & processing — https://help.keka.com/hc/en-us/sections/39012476193041-Payroll-setup-processing
- Run Payroll — https://help.keka.com/hc/en-us/sections/39012477442577-Run-Payroll
- Statutory Compliances — https://help.keka.com/hc/en-us/sections/39012461020561-Statutory-Compliances
- Income Tax — https://help.keka.com/hc/en-us/sections/39012453659665-Income-Tax
- Employee Salary Management — https://help.keka.com/hc/en-us/sections/39012452138513-Employee-Salary-Management
- Payslip Management — https://help.keka.com/hc/en-us/sections/39012487987729-Payslip-Management
- Loans & Advances — https://help.keka.com/hc/en-us/sections/39013095228049-Loans-Advances
- Managing perks and component claims — https://help.keka.com/hc/en-us/sections/39012474212753-Managing-perks-and-component-claims
- Payroll Analytics and Reports — https://help.keka.com/hc/en-us/sections/39928143088273-Analytics-and-Reports
- Payroll Expense Management — https://help.keka.com/hc/en-us/sections/39012452900625-Expense-Management
- US Payroll — https://help.keka.com/hc/en-us/sections/39012522231953-US-Payroll
- AE Payroll — https://help.keka.com/hc/en-us/sections/39928140951185-AE-Payroll
- Payroll FAQs — https://help.keka.com/hc/en-us/sections/39012475535121-Payroll-FAQs
- Expenses & Travel — https://help.keka.com/hc/en-us/sections/39011006739089-Expenses-Travel
- Expense & Travel Management — https://help.keka.com/hc/en-us/sections/40218008012945-Expense-Travel-Management
- Expenses & Travel FAQs — https://help.keka.com/hc/en-us/sections/39012251871633-Expenses-Travel-FAQS
- HelpDesk — https://help.keka.com/hc/en-us/sections/39010992203025-HelpDesk
- Helpdesk Management — https://help.keka.com/hc/en-us/sections/40216786392465-Helpdesk-Management
- HelpDesk FAQs — https://help.keka.com/hc/en-us/sections/39012275996433-HelpDesk-FAQS

## Core HR articles
- Setting up the organizational structure — https://help.keka.com/admin/setting-up-the-organizational-structure
- Managing Employee Profiles on Keka HR — https://help.keka.com/admin/managing-employee-profiles-on-keka-hr · https://help.keka.com/hc/en-us/articles/39946786383889-Managing-Employee-Profiles-on-Keka-HR
- Adding a new employee — https://help.keka.com/admin/adding-a-new-employee · https://help.keka.com/hc/en-us/articles/39946620557969-Adding-a-new-employee
- Updating employee details in Keka — https://help.keka.com/hc/en-us/articles/39946629892881-Updating-employee-details-in-Keka
- Adding and modifying locations — https://help.keka.com/hc/en-us/articles/39946667398929-Adding-and-modifying-locations
- How to setup an employee number series on Keka? — https://help.keka.com/hc/en-us/articles/39946565641745-How-to-setup-an-employee-number-series-on-Keka
- How to edit employee number on Keka? — https://help.keka.com/hc/en-us/articles/39946559886737-How-to-edit-employee-number-on-Keka
- How to edit/delete a custom field for employee profile? — https://help.keka.com/hc/en-us/articles/39946618229777-How-to-edit-delete-a-custom-field-for-employee-profile
- How to make employee custom fields mandatory? — https://help.keka.com/admin/admin-help/how-to-make-employee-custom-fields-mandatory
- How to add Employee Custom Fields? — https://keka.freshdesk.com/support/solutions/articles/84000383164-how-to-add-employee-custom-fields-
- Managing ID Card Settings in Keka — https://help.keka.com/hc/en-us/articles/39946699709329-Managing-ID-Card-Settings-in-Keka
- Preboarding Overview — https://help.keka.com/hc/en-us/articles/39946667555857-Preboarding-Overview
- Creating Offer Templates — https://help.keka.com/hc/en-us/articles/39946726416529-Creating-Offer-Templates
- Setting up Task Templates on Keka — https://help.keka.com/hc/en-us/articles/39946720114449-Setting-up-Task-Templates-on-Keka
- Create and manage Profile Field Task Templates — https://help.keka.com/hc/en-us/articles/39946715858065-Create-and-manage-Profile-Field-Task-Templates
- Dependent Tasks in Keka Task Templates — https://help.keka.com/hc/en-us/articles/39946745738129-Dependent-Tasks-in-Keka-Task-Templates
- Managing Preboarding Page — https://help.keka.com/hc/en-us/articles/39946720098705-Managing-Preboarding-Page
- Preboarding Walkthrough — https://help.keka.com/hc/en-us/articles/39946867653393-Preboarding-Walkthrough
- Managing the Candidate Experience Portal on Keka — https://help.keka.com/admin/managing-the-candidate-experience-portal-on-keka
- Initiating Onboarding for Employees — https://help.keka.com/hc/en-us/articles/39946653303441-Initiating-Onboarding-for-Employees
- Configuring and Managing Probation Policies — https://help.keka.com/admin/configuring-and-managing-probation-policies
- Employee exits on Keka - Overview — https://help.keka.com/hc/en-us/articles/39946725816209-Employee-exits-on-Keka-Overview
- Initiating the Exit Process — https://help.keka.com/hc/en-us/articles/39946630255761-Initiating-the-Exit-Process
- Exit process of an employee — https://help.keka.com/hc/en-us/articles/39946701666449-Exit-process-of-an-employee
- Understanding the Exit Process Tab in Keka — https://help.keka.com/hc/en-us/articles/39946791454865-Understanding-the-Exit-Process-Tab-in-Keka
- Creating and Managing Notice Period Settings — https://help.keka.com/hc/en-us/articles/39946768364305-Creating-and-Managing-Notice-Period-Settings
- Configuring Exit Tasks in Keka — https://help.keka.com/hc/en-us/articles/39946822053265-Configuring-Exit-Tasks-in-Keka
- Managing resignation/termination settings and exit reasons — https://help.keka.com/hc/en-us/articles/39946721627281-Managing-resignation-termination-settings-and-exit-reasons
- Raise Backfill Requisition from Exit Approval — https://help.keka.com/hc/en-us/articles/41513631754001-Raise-Backfill-Requisition-from-Exit-Approval
- Configuring Exit Survey — https://help.keka.com/admin/configuring-exit-survey · video https://help.keka.com/hc/en-us/articles/39946861481233-Configuring-Exit-Survey-Video
- Managing Employee Documents — https://help.keka.com/hc/en-us/articles/39946717792145-Managing-Employee-Documents
- Managing Expired and Expiring Employee Documents — https://help.keka.com/hc/en-us/articles/39946780445457-Managing-Expired-and-Expiring-Employee-Documents
- Creating and Managing Document Templates — https://help.keka.com/hc/en-us/articles/39946772476817-Creating-and-Managing-Document-Templates
- How to create a new Letter Template on Keka? — https://help.keka.com/hc/en-us/articles/39946702377233-How-to-create-a-new-Letter-Template-on-Keka
- How to generate employee letters? — https://help.keka.com/hc/en-us/articles/39946880264081
- Edit and Customize Document Templates — https://help.keka.com/hc/en-us/articles/41059994466449
- DocuSign digital signature — https://help.keka.com/hc/en-us/articles/39946796352017-How-to-generate-document-with-digital-signature-using-DocuSign
- Integrating DocuSign in Keka / offer letters — https://help.keka.com/hc/en-us/articles/39946820072209-Integrating-Docusign-in-Keka
- eSign / Digital Signature Partners guide — https://developers.keka.com/docs/esign-partners-guide
- TRUESigner ONE marketplace app — https://www.keka.com/marketplace/app/truesignerone
- Managing Assets in Keka — https://help.keka.com/hc/en-us/articles/39946708828305-Managing-Assets-in-Keka · https://help.keka.com/admin/managing-assets
- Managing Asset Conditions — https://help.keka.com/hc/en-us/articles/39946765997201-Managing-Asset-Conditions
- Overview - Roles & Permissions — https://help.keka.com/hc/en-us/articles/39946719445393-Overview-Roles-Permissions
- Understanding User Roles — https://help.keka.com/hc/en-us/articles/39946742389521-Understanding-User-Roles
- Assigning Roles & Permissions (docs.keka.com) — https://docs.keka.com/faq/assigning-roles-permissions/
- Tracking Growth, Exits and Retention using Analytics — https://help.keka.com/admin/tracking-growth-exits-and-retention-using-analytics
- Keka's New Report Emailing Automation — https://help.keka.com/hc/en-us/articles/39946790828433-Keka-s-New-Report-Emailing-Automation
- How to Give Praise to an Employee in Keka? — https://help.keka.com/hc/en-us/articles/39838176470289-How-to-Give-Praise-to-an-Employee-in-Keka
- Boosting Your Success Journey: Feedback and Praise — https://help.keka.com/admin/boosting-your-success-journey-feedback-and-praise
- Ongrid Integration with Keka — https://help.keka.com/hc/en-us/articles/39946713812881-Ongrid-Integration-with-Keka
- Integrating SpringVerify with Keka — https://help.keka.com/admin/integrating-springverify-with-keka-2
- Adding and Managing Custom BGV Vendors in Keka — https://help.keka.com/hc/en-us/articles/39946693819537-Adding-and-Managing-Custom-BGV-Vendors-in-Keka
- Background Verification Partners Guide — https://developers.keka.com/docs/background-verification-partners-guide
- Background verification for Preboarding Candidates — https://help.keka.com/admin/background-verification-through-keka-hr
- Tracking & Initiating Background Verification — https://help.keka.com/admin/tracking-initiating-background-verification-1

## Helpdesk articles
- Understanding Keka's Helpdesk — https://help.keka.com/hc/en-us/articles/39946632743697-Understanding-Keka-s-Helpdesk
- Creating a New Helpdesk Category — https://help.keka.com/hc/en-us/articles/48866672049681-Creating-a-New-Helpdesk-Category
- Managing Helpdesk Settings — https://help.keka.com/hc/en-us/articles/39946725231249-Managing-Helpdesk-Settings
- Managing Helpdesk Tickets — https://help.keka.com/hc/en-us/articles/39946710748049-Managing-Helpdesk-Tickets
- Understanding the Helpdesk Summary Tab — https://help.keka.com/hc/en-us/articles/39946838983569-Understanding-the-Helpdesk-Summary-Tab
- Accessing Helpdesk Reports — https://help.keka.com/hc/en-us/articles/39946611826321-Accessing-Helpdesk-Reports
- Raising and following an internal ticket — https://help.keka.com/hc/en-us/articles/39946848514321-Raising-and-following-an-internal-ticket

## Payroll articles
- **Running payroll on Keka (the 6 steps)** — https://help.keka.com/hc/en-us/articles/39946563404561-Running-payroll-on-Keka
- Processing Payroll in 6 Simple Steps (video) — https://www.youtube.com/watch?v=7Iux49bD6ZM
- Approval Workflow (Maker-Checker) for Payroll Finalisation — https://help.keka.com/hc/en-us/articles/41388353533073-Approval-Workflow-Maker-Checker-for-Payroll-Finalisation
- Introducing Off-Cycle Payroll — https://help.keka.com/hc/en-us/articles/39946668015889-Introducing-Off-Cycle-Payroll
- Understanding Payroll Inputs in Off-Cycle Payroll — https://help.keka.com/hc/en-us/articles/39946812385681-Understanding-Payroll-Inputs-in-Off-Cycle-Payroll
- Post Payroll Actions for Off-Cycle Runs — https://help.keka.com/hc/en-us/articles/39946785501073-Post-Payroll-Actions-for-Off-Cycle-Runs
- Introduction to Partial Salary Hold Feature — https://help.keka.com/hc/en-us/articles/39946830821137-Introduction-to-Partial-Salary-Hold-Feature
- Navigating the Partial Salary Hold Feature — https://help.keka.com/hc/en-us/articles/39946830930705-Navigating-the-Partial-Salary-Hold-Feature
- Creating and configuring a new pay group — https://help.keka.com/hc/en-us/articles/39946630038673-Creating-and-configuring-a-new-pay-group
- Creating and managing salary structures for a pay group — https://help.keka.com/hc/en-us/articles/39946778678289-Creating-and-managing-salary-structures-for-a-pay-group
- Managing salary components — https://help.keka.com/hc/en-us/articles/39946721937681-Managing-salary-components · https://help.keka.com/hc/en-us/articles/39946663573009-Managing-salary-components
- Managing Earnings and Deductions in Keka — https://help.keka.com/hc/en-us/articles/39946786502801-Managing-Earnings-and-Deductions-in-Keka
- Managing taxes and deduction settings for a pay group — https://help.keka.com/hc/en-us/articles/39946620805265-Managing-taxes-and-deduction-settings-for-a-pay-group
- Configuring payslip, full and final and other important pay group settings — https://help.keka.com/hc/en-us/articles/39946768555409-Configuring-payslip-full-and-final-and-other-important-pay-group-settings
- Editing Pay Schedule for a Pay Group — https://help.keka.com/hc/en-us/articles/39946711740177-Editing-Pay-Schedule-for-a-Pay-Group
- Threshold value for a component to be effected by LOP — https://help.keka.com/hc/en-us/articles/39946770080657-Threshold-value-for-a-component-to-be-effected-by-LOP
- Introducing Monthly & Hourly Remuneration in Keka — https://help.keka.com/hc/en-us/articles/39946700255761-Introducing-Monthly-Hourly-Remuneration-in-Keka
- Setting Up and Managing Hourly Remuneration in Keka — https://help.keka.com/hc/en-us/articles/39946781489937-Setting-Up-and-Managing-Hourly-Remuneration-in-Keka
- How to Configure and Use Piece-Based Remuneration in Keka — https://help.keka.com/hc/en-us/articles/39946830193041-How-to-Configure-and-Use-Piece-Based-Remuneration-in-Keka
- Switching Remuneration Type of Employees — https://help.keka.com/hc/en-us/articles/39946713584657-Switching-Remuneration-Type-of-Employees
- Keka Payroll Self-Onboarding Guide — https://help.keka.com/hc/en-us/articles/39946782076177-Keka-Payroll-Self-Onboarding-Guide
- Understanding Errors and Guided Fixes in Keka — https://help.keka.com/hc/en-us/articles/39946817596305-Understanding-Errors-and-Guided-Fixes-in-Keka
- Managing Notice Period Buyout policies — https://help.keka.com/hc/en-us/articles/39946699424401-Managing-Notice-Period-Buyout-policies
- Managing leave encashment policies — https://help.keka.com/hc/en-us/articles/39946693198353-Managing-leave-encashment-policies
- Enabling & Disabling the payroll status of employees — https://help.keka.com/hc/en-us/articles/39946772629905-Enabling-Disabling-the-payroll-status-of-employees
- Managing the payroll status of employees — https://help.keka.com/hc/en-us/articles/39946725861393-Managing-the-payroll-status-of-employees

## Statutory & tax
- Updating PF settings for a pay group — https://help.keka.com/hc/en-us/articles/39946817571729-Updating-PF-Provident-Fund-settings-for-a-pay-group
- Managing ESI contributions for a pay group — https://help.keka.com/hc/en-us/articles/39946725885073-Managing-the-Employees-State-Insurance-ESI-contributions-for-a-pay-group
- ESI Calculation Fix: Including Arrears in ESI Contributions — https://help.keka.com/hc/en-us/articles/41208072170385-ESI-Calculation-Fix-Including-Arrears-in-ESI-Contributions
- Managing LWF contribution settings for a pay group — https://help.keka.com/hc/en-us/articles/39946712012433-Managing-Labour-Welfare-Fund-LWF-contribution-settings-for-a-pay-group · video https://help.keka.com/hc/en-us/articles/39946871713553-Managing-Labour-Welfare-Fund-LWF-contribution-settings-for-a-pay-group-Video
- Managing IT, PF, LWF, Professional Tax, and ESI filing details — https://help.keka.com/hc/en-us/articles/39946667222161-Managing-IT-PF-LWF-Professional-Tax-and-ESI-filing-details-for-the-pay-group
- Professional Tax Calculation in Tamil Nadu by Corporation or Panchayat — https://help.keka.com/hc/en-us/articles/42629831023121-Professional-Tax-Calculation-in-Tamil-Nadu-by-Corporation-or-Panchayat
- Professional Tax (PT) Deduction for Exit Employees (Half-Yearly & Monthly) — https://help.keka.com/hc/en-us/articles/43889873965329-Professional-Tax-PT-Deduction-for-Exit-Employees-Half-Yearly-Monthly
- Labour Codes 2025: HR & Payroll Compliance Guide for Keka Users — https://help.keka.com/hc/en-us/articles/41464340017937-Labour-Codes-2025-HR-Payroll-Compliance-Guide-for-Keka-Users
- Gratuity Calculation Correction - 5 day / 6 day working week — https://help.keka.com/hc/en-us/articles/47058215233425-Gratuity-Calculation-Correction-Support-5-day-6-day-working-days-week
- Pay Register Visibility for Outside CTC Contributions — https://help.keka.com/hc/en-us/articles/47955353405329-Pay-Register-Visibility-for-Outside-CTC-Contributions
- How to generate monthly PF ECR report — https://help.keka.com/hc/en-us/articles/39946688739345-How-to-generate-monthly-PF-ECR-report
- How to generate monthly ESIC ECR report — https://help.keka.com/hc/en-us/articles/39946522070545-How-to-generate-monthly-ESIC-ECR-report
- How to enable gratuity in the F&F payout? — https://help.keka.com/hc/en-us/articles/39946737510929-How-to-enable-gratuity-in-the-F-F-payout
- Gratuity (docs.keka.com) — https://docs.keka.com/faq/payroll/gratuity/
- How do we calculate the amount of gratuity exempted from tax? — https://help.keka.com/hc/en-us/articles/39946690725009-How-do-we-calculate-the-amount-of-gratuity-exempted-from-tax
- Managing Income Tax — https://help.keka.com/hc/en-us/articles/39946612747793-Managing-Income-Tax
- Understanding Reasons for Change in Income Tax — https://help.keka.com/hc/en-us/articles/39946613255825-Understanding-Reasons-for-Change-in-Income-Tax
- Configuring tax declaration settings — https://help.keka.com/hc/en-us/articles/39946695482641-Configuring-tax-declaration-settings
- Declaring investments for tax saving — https://help.keka.com/hc/en-us/articles/39946743856657-Declaring-investments-for-tax-saving
- Understanding IT Declarations: Declared vs Approved Amounts, Status, and Cut-Off — https://help.keka.com/hc/en-us/articles/43087286925713-Understanding-IT-Declarations-Declared-vs-Approved-Amounts-Status-and-Cut-Off
- Locking and Unlocking IT Declaration & Proof Submission — https://help.keka.com/hc/en-us/articles/39946718427793-Locking-and-Unlocking-IT-Declaration-Proof-Submission
- Approving or rejecting tax declarations by employees — https://help.keka.com/hc/en-us/articles/39946719540881-Approving-or-rejecting-tax-declarations-by-employees
- Configuring Tax-Exempt Salary Components under the New Tax Regime — https://help.keka.com/hc/en-us/articles/39946721916817-Configuring-Tax-Exempt-Salary-Components-under-the-New-Tax-Regime-in-Keka
- Include Outside Annual Salary Components in Tax Computation — https://help.keka.com/hc/en-us/articles/42748406580625-Include-Outside-Annual-Salary-Components-in-Tax-Computation
- Assign Earning Section to Salary Components for Tax Reporting — https://help.keka.com/hc/en-us/articles/41743176157073-Assign-Earning-Section-to-Salary-Components-for-Tax-Reporting
- Managing Form 16 for your employees — https://help.keka.com/hc/en-us/articles/39946614310673-Managing-Form-16-for-your-employees
- Generating TDS returns (Form 24Q) for salaried employees — https://help.keka.com/hc/en-us/articles/39946687266193-Generating-TDS-returns-Form-24Q-for-salaried-employees
- File TDS for Contractual Payments Using Form 26Q in Keka — https://help.keka.com/hc/en-us/articles/41860787164433-File-TDS-for-Contractual-Payments-Using-Form-26Q-in-Keka
- How to generate Form 12 BB on Keka? — https://support.keka.com/support/solutions/articles/84000380218-how-to-generate-form-12-bb-on-keka-
- How to get the status report of proof submissions for IT declaration? — https://help.keka.com/hc/en-us/articles/39946625479953-How-to-get-the-status-report-of-proof-submissions-for-IT-declaration

## Salary, payslips, payments, loans, perks, expenses
- Managing employees' payslips — https://help.keka.com/hc/en-us/articles/39946667484177-Managing-employees-payslips
- Configuring payslip settings on Keka — https://help.keka.com/hc/en-us/articles/39946693221649-Configuring-payslip-settings-on-Keka
- Understanding Your Payslips: Regular vs. Off-Cycle Payroll — https://help.keka.com/hc/en-us/articles/39946842907793-Understanding-Your-Payslips-Regular-vs-Off-Cycle-Payroll-in-Keka
- Send full & final statements to employees' personal email addresses — https://help.keka.com/hc/en-us/articles/47983240704273-Send-full-final-statements-to-employees-personal-email-addresses
- Customizing the Pay Register on Keka — https://help.keka.com/hc/en-us/articles/39946721353361-Customizing-the-Pay-Register-on-Keka
- How to check the pay register? — https://help.keka.com/admin/admin-help/how-to-check-the-pay-register
- Viewing and updating employee salary payment modes and bank details — https://help.keka.com/hc/en-us/articles/39946612932625-Viewing-and-updating-employee-salary-payment-modes-and-bank-details
- Introducing Employee Bank Verification in Keka — https://help.keka.com/hc/en-us/articles/39946667920017-Introducing-Employee-Bank-Verification-in-Keka
- Setting up salary payment automation — https://help.keka.com/admin/setting-up-salary-automation
- FAQ's for salary payment automation — https://help.keka.com/admin/faqs-1
- Processing a Full and Final (F&F) Settlement — https://help.keka.com/hc/en-us/articles/39946770277009-Processing-a-Full-and-Final-F-F-Settlement · video https://help.keka.com/hc/en-us/articles/39946684533649-Processing-a-Full-and-Final-F-F-Settlement-Video
- Post-F&F Adjustments for Exited Employees — https://help.keka.com/hc/en-us/articles/42594036245137-Post-F-F-Adjustments-for-Exited-Employees
- Managing loan categories and loan policies — https://help.keka.com/hc/en-us/articles/39946742065425-Managing-loan-categories-and-loan-policies · https://help.keka.com/hc/en-us/articles/39946692029201-Managing-loan-categories-and-loan-policies
- Managing loan policy assignments — https://help.keka.com/hc/en-us/articles/39946712114321-Managing-loan-policy-assignments
- Manage ongoing loans — https://help.keka.com/hc/en-us/articles/39946757543441-Manage-ongoing-loans
- Category-Wise Loan EMI in Payroll — https://help.keka.com/hc/en-us/articles/39946816886033-Category-Wise-Loan-EMI-in-Payroll
- Assigning and Managing Leave Advance Policies — https://help.keka.com/hc/en-us/articles/47909086173713-Assigning-and-Managing-Leave-Advance-Policies
- Where to find all the outstanding loan details? — https://help.keka.com/hc/en-us/articles/39946666780817-Where-to-find-all-the-outstanding-loan-details
- Adding and Managing Perks — https://help.keka.com/hc/en-us/articles/39946757222289-Adding-and-Managing-Perks
- Assigning perks to employees — https://help.keka.com/hc/en-us/articles/39946713478929-Assigning-perks-to-employees
- Approving or Rejecting Component Claims — https://help.keka.com/hc/en-us/articles/39946699094417-Approving-or-Rejecting-Component-Claims
- Understanding Tax-Saving Reimbursements — https://help.keka.com/hc/en-us/articles/39946778649489-Understanding-Tax-Saving-Reimbursements
- Manually overriding reimbursable component claims — https://help.keka.com/hc/en-us/articles/39946584056337-Manually-overriding-reimbursable-component-claims
- Configuring and processing Earned bonus on Keka — https://help.keka.com/hc/en-us/articles/39946718082449-Configuring-and-processing-Earned-bonus-on-Keka
- Adding Bonus as part of Annual Salary — https://help.keka.com/hc/en-us/articles/39946711702033-Adding-Bonus-as-part-of-Annual-Salary
- Importing bonuses with payout date in bulk — https://help.keka.com/hc/en-us/articles/39946711756945-Importing-bonuses-with-payout-date-in-bulk
- Importing salary and salary structure revisions in bulk — https://help.keka.com/hc/en-us/articles/39946726268305-Importing-salary-and-salary-structure-revisions-in-bulk
- Importing financial information in bulk — https://help.keka.com/hc/en-us/articles/39946766099985-Importing-financial-information-in-bulk
- Importing investment declarations in bulk — https://help.keka.com/hc/en-us/articles/39946667250833-Importing-investment-declarations-in-bulk
- Importing pay group assignments in bulk — https://help.keka.com/hc/en-us/articles/39946720034449-Importing-pay-group-assignments-in-bulk
- Managing salary component, contributions, and TDS overrides — https://help.keka.com/hc/en-us/articles/39946719976081-Managing-salary-component-contributions-and-TDS-overrides
- Managing employee statutory information — https://help.keka.com/hc/en-us/articles/39946718021137-Managing-employee-statutory-information
- Managing Employee PAN details — https://help.keka.com/hc/en-us/articles/39946772618769-Managing-Employee-PAN-details
- Audit Logs for Employees' Finance — https://help.keka.com/hc/en-us/articles/39946613202321-Audit-Logs-for-Employees-Finance
- Overview of Expenses & Travel — https://help.keka.com/hc/en-us/articles/39946616084625-Overview-of-Expenses-Travel
- Managing expense & travel policies for your organization — https://help.keka.com/hc/en-us/articles/39946792111633-Managing-expense-travel-policies-for-your-organization
- Overview of Managing Expense and Travel Policies — https://help.keka.com/hc/en-us/articles/39946778019217-Overview-of-Managing-Expense-and-Travel-Policies
- Creating & Managing Expense & Travel Categories — https://help.keka.com/hc/en-us/articles/39946746949393-Creating-Managing-Expense-Travel-Categories
- Configuring approval chain at expense category level — https://help.keka.com/hc/en-us/articles/39946601457553-Configuring-approval-chain-at-expense-category-level
- Managing Claim Settings — https://help.keka.com/hc/en-us/articles/39946668276881-Managing-Claim-Settings
- Using Advances in Expenses & Travel — https://help.keka.com/hc/en-us/articles/39946779166865-Using-Advances-in-Expenses-Travel
- Understanding Currency Conversions — https://help.keka.com/hc/en-us/articles/39946778035473-Understanding-Currency-Conversions
- Tracking & Managing Your Expenses — https://help.keka.com/hc/en-us/articles/39946616133649-Tracking-Managing-Your-Expenses
- Exploring Travel Desk — https://help.keka.com/hc/en-us/articles/39946628590609-Exploring-Travel-Desk
- Understanding Expenses & Travel Dashboard — https://help.keka.com/hc/en-us/articles/39946668545809-Understanding-Expenses-Travel-Dashboard
- Understanding Expenses & Travel Reports — https://help.keka.com/hc/en-us/articles/39946737040017-Understanding-Expenses-Travel-Reports
- Expense Claim Form — https://help.keka.com/hc/en-us/articles/39946846350865-Expense-Claim-Form

## Reports, analytics, integrations
- Using Payroll Reports on Keka — https://help.keka.com/admin/using-payroll-reports-on-keka · https://help.keka.com/hc/en-us/articles/39946740064913-Using-Payroll-Reports-on-Keka
- Compensation Planning — https://help.keka.com/hc/en-us/articles/39946882192657-Compensation-Planning
- Estimating Compensation Budgets — https://help.keka.com/hc/en-us/articles/39946750081937-Estimating-Compensation-Budgets
- Compare Compensation Cost — https://help.keka.com/hc/en-us/articles/39946698983185-Compare-Compensation-Cost
- Comparing Employee Competitiveness — https://help.keka.com/hc/en-us/articles/39946630066193-Comparing-Employee-Competitiveness
- Understanding the Geographical Differentials Tab in Payroll Analytics — https://help.keka.com/hc/en-us/articles/39946721899665-Understanding-the-Geographical-Differentials-Tab-in-Payroll-Analytics
- Accounting Integration with Zoho Books — https://help.keka.com/hc/en-us/articles/39946770475153-Accounting-Integration-with-Zoho-Books
- How to integrate Tally with Keka? — https://help.keka.com/admin/admin-help/how-to-integrate-tally-with-keka
- Quickbook Integration — https://help.keka.com/hc/en-us/articles/43055995694353-Quickbook-Integeration
- Keka payroll integration with third-party systems — https://help.keka.com/hc/en-us/articles/39946812877457-Keka-payroll-integration-with-third-party-systems
- Keka Marketplace (all apps) — https://www.keka.com/marketplace-all-apps · https://www.keka.com/marketplace
- Keka developer docs — https://developers.keka.com/

## US / GCC payroll
- US Payroll section (30 articles) — https://help.keka.com/hc/en-us/sections/39012522231953-US-Payroll
- Manage Garnishments and Post-Tax Deductions in Keka US Payroll — https://help.keka.com/hc/en-us/articles/49015126613393-Manage-Garnishments-and-Post-Tax-Deductions-in-Keka-US-Payroll
- Minimum Wage Validation in US Payroll — https://help.keka.com/hc/en-us/articles/39946826536209-Minimum-Wage-Validation-in-US-Payroll
- Tax Filing Section — https://help.keka.com/hc/en-us/articles/39946744576529-Tax-Filing-Section
- Understanding Fixed Compensation for Contractors in Keka — https://help.keka.com/hc/en-us/articles/44654657089681-Understanding-Fixed-Compensation-for-Contractors-in-Keka
- Tax Documents for Employees and Contractors (US Payroll) — https://help.keka.com/hc/en-us/articles/39946793012241-Tax-Documents-for-Employees-and-Contractors-US-Payroll
- AE Payroll section (11 articles) — https://help.keka.com/hc/en-us/sections/39928140951185-AE-Payroll
- End of Service Gratuity in GCC Countries — https://help.keka.com/hc/en-us/articles/39946742534033-End-of-Service-Gratuity-in-GCC-Countries
- Understanding Social Insurance Contributions for GCC Countries — https://help.keka.com/hc/en-us/articles/39946695342353-Understanding-Social-Insurance-Contributions-for-GCC-Countries
- GCC Social Insurance Contribution Updates: Oman and Saudi Arabia — https://help.keka.com/hc/en-us/articles/41208049971345-GCC-Social-Insurance-Contribution-Updates-Key-Changes-for-Oman-and-Saudi-Arabia
- Managing DEWS Contributions in Keka (DIFC Free Zone) — https://help.keka.com/hc/en-us/articles/39946838915345-Managing-DEWS-Contributions-in-Keka-DIFC-Free-Zone
- Configure Air Ticket Benefits for Employees in the GCC — https://help.keka.com/hc/en-us/articles/39946713552913-Configure-Air-Ticket-Benefits-for-Employees-in-the-GCC-on-Keka
- US payroll marketing site — https://www.keka.com/us/payroll-software
- US regional site — https://www.keka.com/us/
- UAE payroll marketing site (WPS-ready) — https://www.keka.com/ae/payroll-processing
- Keka reviews on G2 — https://www.g2.com/products/keka/reviews

## Pricing / marketing / third-party
- Keka pricing — https://www.keka.com/pricing
- Keka payroll processing (robots-blocked to fetcher) — https://www.keka.com/payroll-processing
- Keka payroll compliance — https://www.keka.com/payroll-compliance
- Keka global companies (robots-blocked to fetcher) — https://www.keka.com/global-companies
- Keka employee document management — https://www.keka.com/employee-document-management
- Keka employee profiles — https://www.keka.com/employee-profiles
- **[REVIEW]** Keka HR Review 2026 (hr.software) — https://www.hr.software/reviews/keka
- **[REVIEW]** Keka review (peoplemanagingpeople) — https://peoplemanagingpeople.com/tools/keka-hr-review/
- **[REVIEW]** Keka reviews (hrstacks) — https://www.hrstacks.com/product/keka/
- **[REVIEW — COMPETITOR, treat as adversarial]** hrone.cloud Keka posts — https://hrone.cloud/blog/keka-hrms-review/ · https://hrone.cloud/blog/keka-integrations/ · https://hrone.cloud/blog/keka-pricing-india/
- Keka HR (Wikipedia) — https://en.wikipedia.org/wiki/Keka_HR

## Legacy / alternate documentation domains
- Legacy admin help root — https://help.keka.com/admin/core-hr · https://help.keka.com/admin/payroll
- docs.keka.com — https://docs.keka.com/faq/payroll/gratuity/ · https://docs.keka.com/faq/assigning-roles-permissions/
- Freshdesk archive (robots-blocked to automated fetch, reachable in a browser) — https://support.keka.com/support/solutions/ · https://keka.freshdesk.com/support/solutions/
