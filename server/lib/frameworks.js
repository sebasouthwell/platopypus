// Assessment frameworks employers use to judge candidates. Each entry: the scale, the elements (or how to find them),
// how to tell which framework and level a job uses, and notes for assessors, written in our own words. Official
// descriptions (some are licensed, e.g. SFIA) are read from the owner's site at assessment time, never copied here.
//
// Used by Job Hunt: agents assess a job against the framework it uses, a blind second assessor rates the same elements,
// and the person can keep a profile per framework (their SFIA levels, their Success Profiles examples) across jobs.

export const FRAMEWORKS = {
    'success-profiles': {
        title: 'Civil Service Success Profiles', owner: 'UK Civil Service', region: 'UK', url: 'https://www.gov.uk/government/publications/success-profiles',
        detect: [/success profiles?/i, /\bbehaviours?\b.*\b(seeing the big picture|delivering at pace|making effective decisions|working together|communicating and influencing)/i, /\b(AA|AO|EO|HEO|SEO|G7|G6|Grade 7|Grade 6|SCS)\b.*civil service|civil service.*\b(AA|AO|EO|HEO|SEO|G7|G6|Grade 7|Grade 6)\b/i, /civil service jobs/i],
        kinds: { behaviour: 'Behaviours', strength: 'Strengths', experience: 'Experience', technical: 'Technical', ability: 'Ability (tests)' },
        elements: ['Seeing the Big Picture', 'Changing and Improving', 'Making Effective Decisions', 'Leadership', 'Communicating and Influencing', 'Working Together', 'Developing Self and Others', 'Managing a Quality Service', 'Delivering at Pace'].map(n => ({ id: n.toLowerCase().replace(/[^a-z]+/g, '-'), name: n, kind: 'behaviour' })),
        levels: { 1: 'Level 1 (AA, AO)', 2: 'Level 2 (EO)', 3: 'Level 3 (HEO, SEO)', 4: 'Level 4 (G7, G6)', 5: 'Level 5 (SCS1)', 6: 'Level 6 (SCS2)' },
        scale: { 1: 'Insufficient evidence', 2: 'Minimal evidence', 3: 'Moderate evidence', 4: 'Acceptable', 5: 'Good', 6: 'Strong', 7: 'Outstanding' },
        notes: 'The advert names the grade and the behaviours assessed (often 3 to 6), plus experience, technical, strength or ability elements. Behaviours are scored on the 1–7 evidence scale against the level indicators for the grade: 4 is usually the pass mark. Behaviour statements are typically 250 words in STAR form, with one clear example each; the personal statement is often 500–1250 words against the essential criteria. Score only what the example shows the candidate personally did. The level indicators for each behaviour and grade are on GOV.UK.',
    },
    sfia: {
        title: 'SFIA (Skills Framework for the Information Age)', owner: 'SFIA Foundation', region: 'Global', url: 'https://sfia-online.org/',
        detect: [/\bSFIA\b/i, /skills framework for the information age/i],
        kinds: { skill: 'Professional skills', attribute: 'Generic attributes' },
        elements: ['Autonomy', 'Influence', 'Complexity', 'Knowledge', 'Business skills and behavioural factors'].map(n => ({ id: n.toLowerCase().replace(/[^a-z]+/g, '-'), name: n, kind: 'attribute' })),
        elementsNote: 'Professional skills (over 100, each with a four-letter code such as SCTY, PENT, PROG, DTAN) are picked from the advert or the role; read their level descriptions on sfia-online.org.',
        levels: { 1: '1 Follow', 2: '2 Assist', 3: '3 Apply', 4: '4 Enable', 5: '5 Ensure, advise', 6: '6 Initiate, influence', 7: '7 Set strategy, inspire, mobilise' },
        scale: { 0: 'No evidence', 1: '1 Follow', 2: '2 Assist', 3: '3 Apply', 4: '4 Enable', 5: '5 Ensure, advise', 6: '6 Initiate, influence', 7: '7 Set strategy' },
        notes: 'Each skill is defined only at certain levels; a skill level is shown by sustained work at that level of responsibility (generic attributes: autonomy, influence, complexity, knowledge, business skills). Graduates typically evidence levels 2–3; level 4 needs ownership of work and guiding others. A course project rarely shows more than level 3 autonomy. Use the official level descriptions; quote codes as used by the employer.',
    },
    ddat: {
        title: 'Government Digital and Data Profession Capability Framework (DDaT)', owner: 'UK Government (CDDO)', region: 'UK', url: 'https://ddat-capability-framework.service.gov.uk/',
        detect: [/\bDDaT\b/i, /digital,? data and technology/i, /digital and data profession/i, /capability framework/i],
        kinds: { skill: 'Role skills' },
        elements: [], elementsNote: 'Each role (e.g. security architect, data engineer, software developer) has its own skills; read them on the framework site for the role and level in the advert.',
        levels: { 1: 'Apprentice / trainee', 2: 'Associate / junior', 3: 'Practitioner (mid)', 4: 'Senior', 5: 'Lead', 6: 'Principal', 7: 'Head of' },
        scale: { 0: 'No evidence', 1: 'Awareness', 2: 'Working', 3: 'Practitioner', 4: 'Expert' },
        notes: 'Each role level lists skills with the level expected (awareness, working, practitioner, expert). Map the advert role and level, then judge each skill on the four-step scale. Civil Service adverts using DDaT usually also use Success Profiles (technical elements come from DDaT).',
    },
    'e-cf': {
        title: 'European e-Competence Framework (e-CF, EN 16234)', owner: 'CEN', region: 'EU', url: 'https://itprofessionalism.org/about-it-professionalism/competences/the-e-competence-framework/',
        detect: [/\be-?CF\b/, /e-competence framework/i, /EN 16234/i],
        kinds: { competence: 'e-Competences' }, elements: [], elementsNote: '41 competences in 5 areas (Plan, Build, Run, Enable, Manage), e.g. A.6 Application Design, B.1 Application Development, E.8 Information Security Management.',
        levels: { 1: 'e-1', 2: 'e-2', 3: 'e-3', 4: 'e-4', 5: 'e-5' }, scale: { 0: 'No evidence', 1: 'e-1', 2: 'e-2', 3: 'e-3', 4: 'e-4', 5: 'e-5' },
        notes: 'Proficiency levels e-1 to e-5 roughly track responsibility (e-1 associate, e-2 professional, e-3 senior professional, e-4 lead, e-5 principal). Not every competence exists at every level.',
    },
    ecsf: {
        title: 'European Cybersecurity Skills Framework (ECSF)', owner: 'ENISA', region: 'EU', url: 'https://www.enisa.europa.eu/topics/education/european-cybersecurity-skills-framework',
        detect: [/\bECSF\b/, /european cybersecurity skills framework/i],
        kinds: { profile: 'Role profiles', skill: 'Skills and knowledge' }, elements: ['Chief Information Security Officer', 'Cyber Incident Responder', 'Cyber Legal, Policy and Compliance Officer', 'Cyber Threat Intelligence Specialist', 'Cybersecurity Architect', 'Cybersecurity Auditor', 'Cybersecurity Educator', 'Cybersecurity Implementer', 'Cybersecurity Researcher', 'Cybersecurity Risk Manager', 'Digital Forensics Investigator', 'Penetration Tester'].map(n => ({ id: n.toLowerCase().replace(/[^a-z]+/g, '-'), name: n, kind: 'profile' })),
        levels: { 1: 'Entry', 2: 'Intermediate', 3: 'Advanced' }, scale: { 0: 'No evidence', 1: 'Basic', 2: 'Intermediate', 3: 'Advanced' },
        notes: 'Twelve role profiles, each with tasks, skills and knowledge, mapped to e-CF competences. Judge the profile the job matches, skill by skill.',
    },
    nice: {
        title: 'NICE Workforce Framework for Cybersecurity', owner: 'NIST (US)', region: 'US', url: 'https://niccs.cisa.gov/workforce-development/nice-framework',
        detect: [/\bNICE\b.*(framework|work role)/i, /NIST SP 800-181/i, /work role/i],
        kinds: { role: 'Work roles', tks: 'Tasks, knowledge and skills' }, elements: [], elementsNote: 'Work roles (e.g. Defensive Cybersecurity, Incident Response, Vulnerability Analysis) with task, knowledge and skill statements.',
        levels: { 1: 'Entry', 2: 'Intermediate', 3: 'Advanced' }, scale: { 0: 'No evidence', 1: 'Basic', 2: 'Intermediate', 3: 'Advanced' },
        notes: 'Assess against the task, knowledge and skill statements of the work role the advert names.',
    },
    ciisec: {
        title: 'CIISec Skills Framework', owner: 'Chartered Institute of Information Security', region: 'UK', url: 'https://www.ciisec.org/skills-framework',
        detect: [/\bCIISec\b/i, /\bIISP\b/],
        kinds: { skill: 'Skill groups' }, elements: [], elementsNote: 'Skill groups covering governance, risk, architecture, testing, operations, incident management, forensics and more.',
        levels: { 1: '1 Knowledge', 2: '2 Comprehension', 3: '3 Practitioner', 4: '4 Senior practitioner', 5: '5 Expert', 6: '6 Leader' }, scale: { 0: 'No evidence', 1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6' },
        notes: 'Levels move from knowing about a skill to applying it unsupervised, then leading. Used for UK cyber roles and chartered status.',
    },
    'nhs-ksf': {
        title: 'NHS Knowledge and Skills Framework (KSF)', owner: 'NHS Employers', region: 'UK', url: 'https://www.nhsemployers.org/',
        detect: [/\bKSF\b/, /knowledge and skills framework/i, /agenda for change/i, /\bband [2-9]\b/i],
        kinds: { dimension: 'Dimensions' }, elements: ['Communication', 'Personal and people development', 'Health, safety and security', 'Service improvement', 'Quality', 'Equality and diversity'].map(n => ({ id: n.toLowerCase().replace(/[^a-z]+/g, '-'), name: n, kind: 'dimension' })),
        levels: { 1: 'Level 1', 2: 'Level 2', 3: 'Level 3', 4: 'Level 4' }, scale: { 0: 'No evidence', 1: '1', 2: '2', 3: '3', 4: '4' },
        notes: 'Six core dimensions at levels 1–4, plus specific dimensions for the post. NHS adverts state the Agenda for Change band and a person specification with essential and desirable criteria.',
    },
    competency: {
        title: 'Competencies from the advert (no named framework)', owner: 'the employer', region: 'Any', url: '',
        detect: [], kinds: { essential: 'Essential criteria', desirable: 'Desirable criteria' }, elements: [],
        elementsNote: 'Use the essential and desirable criteria in the advert or person specification.',
        levels: { 1: 'Entry', 2: 'Junior', 3: 'Mid', 4: 'Senior', 5: 'Lead' }, scale: { 0: 'No evidence', 1: 'Limited', 2: 'Some', 3: 'Meets', 4: 'Strong', 5: 'Exceeds' },
        notes: 'Score each criterion 0–5 on evidence; essential criteria without evidence usually mean a sift fail, so say so plainly.',
    },
};
export function list() { return Object.entries(FRAMEWORKS).map(([id, f]) => ({ id, title: f.title, owner: f.owner, region: f.region, url: f.url, kinds: f.kinds, levels: f.levels, scale: f.scale, elements: f.elements, elementsNote: f.elementsNote || '', notes: f.notes })); }
export function get(id) { const f = FRAMEWORKS[id]; if (!f) { const e = new Error(`No framework "${id}". Frameworks: ${Object.keys(FRAMEWORKS).join(', ')}.`); e.status = 400; throw e; } return { id, ...f, detect: undefined }; }
// Which frameworks a job's text points to (strongest first). Falls back to "competency".
export function detect(text) {
    const t = String(text || ''); const hits = [];
    for (const [id, f] of Object.entries(FRAMEWORKS)) { const n = f.detect.filter(re => re.test(t)).length; if (n) hits.push({ id, title: f.title, hits: n }); }
    hits.sort((a, b) => b.hits - a.hits);
    if (!hits.length) hits.push({ id: 'competency', title: FRAMEWORKS.competency.title, hits: 0 });
    return hits;
}
