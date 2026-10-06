// Regression check for the agent's duplicate-content guard, calibrated on the
// letters a looping agent actually re-typed into Google Docs.
// Run: npx tsx scripts/validate-agent-memory.ts
import { AgentWorkingMemory, isNearDuplicateText } from '../src/services/agentWorkingMemory'

const v1 = `To:
The Registrar,
Alhamd Islamic University,
Islamabad.

Subject: Formal Application Regarding Ongoing Final Year Project - Prompt Injection Defense in an AI-Native Browser

Respected Sir/Madam,

I am writing to formally submit information concerning my ongoing final year project, titled "Prompt Injection Defense in an AI-Native Browser."

The primary objective of this project is to develop mechanisms to detect malicious instructions embedded within web content and to protect an AI-powered browsing agent from prompt injection attacks. This work is currently ongoing, focusing on analyzing potential threat vectors in web interactions and exploring effective defense techniques.

Project and Student Details:
Student Name: [Your Name / Placeholder]
- Registration Number: [Registration Number / Placeholder]
- Department: [Department / Placeholder]
- Project Supervisor: [Supervisor Name / Placeholder]
- Project Status: Ongoing
This application is submitted for your information and official university records.

Yours sincerely,
[Your Name / Placeholder]
[Registration Number / Placeholder]`

const v2 = `Subject: Update on Ongoing Final Year Project – Prompt Injection Defense in an AI-Native Browser

Respected Sir/Madam,

I am writing to formally provide details regarding my ongoing Final Year Project titled "Prompt Injection Defense in an AI-Native Browser".

This project aims to detect malicious instructions embedded in web content and protect an AI browsing agent from prompt injection attacks. It is currently ongoing work aimed at securing agent interactions with untrusted websites.

Student Name: [Student Name]
Registration Number: [Registration Number]
Department: [Department Name]
Supervisor: [Supervisor Name]

Yours sincerely,
[Student Name]`

const v3 = `Respected Sir/Madam,

I am writing to provide an update regarding my ongoing Final Year Project titled "Prompt Injection Defense in an AI-Native Browser". The project aims to detect malicious instructions in web content and protect an AI browsing agent. This work is currently ongoing.

Yours obediently,
[Student Name]
[Registration Number]
[Department]
Supervisor: [Supervisor Name]`

const v4 = `I am writing to formally inform your office regarding my ongoing final year project titled "Prompt Injection Defense in an AI-Native Browser" under the Department of [Department Name].

The primary objective of this ongoing research and development project is to investigate and implement defense mechanisms against prompt injection threats. Specifically, the project aims to detect malicious instructions embedded within web content and protect an AI browsing agent from manipulation.

This project is currently ongoing under the supervision of [Supervisor Name].

Thank you for your consideration.

Yours sincerely,

[Student Name]
[Registration Number]
[Department Name]
Alhamd Islamic University, Islamabad`

// Legitimate: letter split into two consecutive chunks — must NOT be flagged.
const partA = `To:
The Registrar,
Alhamd Islamic University,
Islamabad.

Subject: Application Regarding Ongoing Final Year Project

Respected Sir/Madam,

I am writing to inform you about my ongoing final year project titled "Prompt Injection Defense in an AI-Native Browser".`
const partB = `The project aims to detect malicious instructions hidden in web content and to protect an AI browsing agent that reads such pages. The work is ongoing under the guidance of my supervisor.

Yours sincerely,
[Student Name]
[Registration Number]
[Department]
Supervisor: [Supervisor Name]`

const cases: Array<[string, string, string, boolean]> = [
  ['v1 vs v2 (rewrite)', v1, v2, true],
  ['v1 vs v3 (rewrite)', v1, v3, true],
  ['v1 vs v4 (rewrite)', v1, v4, true],
  ['v2 vs v3 (rewrite)', v2, v3, true],
  ['v2 vs v4 (rewrite)', v2, v4, true],
  ['v1 vs v1 (identical)', v1, v1, true],
  ['partA vs partB (continuation)', partA, partB, false],
  // The regression behind "it downloads without writing anything": a title
  // typed first is contained in the letter, and must not block the letter.
  ['title then letter', 'Final Year Project Application - Prompt Injection Defense in an AI-Native Browser', v1, false],
  ['title vs letter body', 'Prompt Injection Defense in an AI-Native Browser', v2, false],
  ['letter then heading', v1, 'Prompt Injection Defense in an AI-Native Browser', false],
  ['letter then large fragment of it', v1, v1.slice(0, 600), true],
  ['v1 vs unrelated', v1, 'Meeting notes: discuss the quarterly budget, hiring plan for the design team, and office move timeline next month.', false],
]

let failed = 0
for (const [name, a, b, expected] of cases) {
  const got = isNearDuplicateText(a, b)
  if (got !== expected) failed++
  console.log(`${got === expected ? 'PASS' : 'FAIL'}  ${name}: duplicate=${got}`)
}

// End-to-end through the memory: first letter typed (unverifiable), rewrite refused.
const memory = new AgentWorkingMemory('write application')
memory.beginStep()
memory.recordContentEntry('type', v1, 'https://docs.google.com/document/d/abc/edit?tab=t.0', 'unverifiable')
const match = memory.findDuplicateContent(v2, 'https://docs.google.com/document/d/abc/edit')
console.log(`${match?.samePage ? 'PASS' : 'FAIL'}  memory refuses rewrite on same doc (query string ignored)`)
if (!match?.samePage) failed++
const titled = new AgentWorkingMemory('write application')
titled.beginStep()
titled.recordContentEntry('type', 'Final Year Project Application - Prompt Injection Defense in an AI-Native Browser', 'https://docs.google.com/document/d/abc/edit', 'unverifiable')
const letterAfterTitle = titled.findDuplicateContent(v1, 'https://docs.google.com/document/d/abc/edit')
console.log(`${letterAfterTitle === null ? 'PASS' : 'FAIL'}  letter is allowed after the title was typed`)
if (letterAfterTitle !== null) failed++
const search = memory.findDuplicateContent('prompt injection', 'https://www.google.com/search')
console.log(`${search === null ? 'PASS' : 'FAIL'}  short search query is never blocked`)
if (search !== null) failed++
const snap = memory.snapshot()
const leaked = JSON.stringify(snap).includes('exploring effective defense techniques')
console.log(`${!leaked ? 'PASS' : 'FAIL'}  full text not sent to planner (previews only); entries=${snap.content_entered?.length}`)
if (leaked) failed++
process.exit(failed)
