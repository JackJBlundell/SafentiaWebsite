// ============================================================================
// BS 9792 Housing standard paragraphs - the reference wording Safentia SHIPS.
//
// These are the paragraph bank an assessing practice would otherwise keep in a
// Word document: numbered, settled wording that is printed VERBATIM against a
// finding, so the same deficiency reads identically whoever assessed it and
// whenever it was assessed. They are the built-in half of the library; an
// organisation adds its own alongside them.
//
// GENERATED from the client's "Standard Paragraph's BS 9792 Housing.docx" and
// then reviewed. Two anomalies in that source are preserved rather than
// silently corrected - a reference number is the client's own citation, and
// rewriting one would change what their report cites:
//   - subject 17 carries a paragraph numbered "16.2.b)" (the source repeats a
//     number from the previous subject);
//   - subject 17's heading in the source reads "FLAMMABLE, COMBUSTIBLE ITEMS
//     AND OTHER DANGEROUS MATERIALS." while its content is furniture and
//     furnishings.
// Both are content decisions for the client, not parsing failures.
//
// ONE SOURCE, NEVER COPIED. This bank is STATIC PRODUCT CONTENT and lives in
// code, not in the database. It is not written into /standardParagraphs/{orgId}
// at provisioning and never duplicated per organisation: 127 paragraphs times
// every customer is data we would then have to migrate in lockstep every time a
// word changes. /standardParagraphs/{orgId} therefore holds an organisation's
// OWN paragraphs and nothing else, and the library lists the union of the two.
// Correcting a paragraph here corrects it for everyone on the next deploy.
//
// IDS ARE FIXED and prefixed `sp-bs9792-`. The prefix is the durable marker of
// a built-in paragraph, exactly as a fixed template id marks a base template:
// an organisation's own paragraphs get RTDB push keys, which always begin "-",
// so the two can never collide and no client write can forge a built-in, and a
// `standardParagraphRef` resolves by looking here first, then at the org node.
// ============================================================================

import type { StandardParagraph } from '../types';

/** The id prefix every shipped BS 9792 paragraph carries. */
export const BS9792_PARAGRAPH_PREFIX = 'sp-bs9792-';

/** Stamped as `updatedAt` on every shipped paragraph. A fixed date rather than
 *  a clock reading, so the bank is deterministic and "Updated" in the library
 *  means a person changed something. Bump it when the wording is revised. */
export const BS9792_PARAGRAPHS_RELEASED_AT = Date.UTC(2026, 8, 10);


/** Subject headings, in report order - the grouping the library lists under.
 *  Keyed by the subject number the source document uses. */
export const BS9792_PARAGRAPH_SUBJECTS: ReadonlyArray<{
  number: number;
  title: string;
}> = [
  { number: 3, title: "Occupants especially at risk from fire" },
  { number: 7, title: "Electrical sources of ignition" },
  { number: 8, title: "Gas installation" },
  { number: 9, title: "Smoking" },
  { number: 10, title: "Arson" },
  { number: 11, title: "Portable heaters and heating and ventilation installations" },
  { number: 12, title: "Cooking" },
  { number: 13, title: "Lightning" },
  { number: 14, title: "Housekeeping" },
  { number: 15, title: "Hazards introduced by outside contractors and building works" },
  { number: 16, title: "Dangerous substances and materials" },
  { number: 17, title: "Flammable, combustible items and other dangerous materials" },
  { number: 18, title: "Construction — floors, walls, ceilings, glazing and stairs" },
  { number: 19, title: "Means of escape" },
  { number: 20, title: "External cladding" },
  { number: 21, title: "Emergency escape lighting" },
  { number: 22, title: "Fire safety signs and notices" },
  { number: 23, title: "Means of giving warning in case of fire" },
  { number: 24, title: "Manual fire extinguishing appliances" },
  { number: 25, title: "Relevant automatic fire extinguishing systems" },
  { number: 26, title: "Facilities and arrangements for firefighters" },
  { number: 27, title: "Procedures and arrangements" },
  { number: 28, title: "Training and drills" },
  { number: 29, title: "Testing and maintenance" },
  { number: 30, title: "Records" },
  { number: 31, title: "Premises information box" },
  { number: 32, title: "Residents engagement strategy" },
];


/** The shipped bank, in document order. */
export const BS9792_STANDARD_PARAGRAPHS: ReadonlyArray<{
  id: string;
  paragraph: StandardParagraph;
}> = [
  {
    id: "sp-bs9792-s3-3-4",
    paragraph: {
      reference: "3.4",
      subject: "Occupants especially at risk from fire",
      body: [
        "To reduce fire risk for vulnerable individuals social housing and support providers should use Person Centred Fire Risk Assessment to identify those at higher risk and to gain an understanding of their risk profile, so appropriate measures can be put in place. The PCFRA considers how a person's characteristics, behaviour and capabilities may increase the likelihood of a fire or affect their ability to recognise and respond to a fire or warning of fire.",
        "Fire Hazards And Their Elimination Or Control"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s7-7-2-a",
    paragraph: {
      reference: "7.2.a)",
      subject: "Electrical sources of ignition",
      body: [
        "It is recommended that a Fixed Wire Test is carried out routinely.",
        "The frequency of testing is specified in the latest version of the EIC/EICR Wiring Regulations (currently BS7671:2018) and is determined by.",
        "The type of installation",
        "How often it is used",
        "The external influences or environment to which the electrical installation is exposed.",
        "The Electrical Installation Certificate, or Electrical Installation Condition Report is a safety Certificate or condition report that is issued by a qualified electrician as confirmation that electrical installation complies with the BS 7671 (IEE Wiring Regulations)."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s7-7-2-b",
    paragraph: {
      reference: "7.2.b)",
      subject: "Electrical sources of ignition",
      body: [
        "It was noted at the time of visit that no evidence of or records in respect of Portable Appliance Testing (PAT) were available.",
        "PAT Testing PAT testing is not, in itself, a legal requirement or obligation. However, current UK legislation states that businesses must maintain electrical equipment in a safe condition.",
        "It is recommended that appropriate Portable Appliance Testing be undertaken by a person who is competent in the safe use of the test equipment and who knows how to interpret the results obtained. The frequency of testing must be assessed by a competent person and is dependent on the risk. It is best practice to record the results of these tests for future reference."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s7-7-2-c",
    paragraph: {
      reference: "7.2.c)",
      subject: "Electrical sources of ignition",
      body: [
        "Extension leads are normally beneath our desks, ‘out of sight and out of mind.’ However, the RP’s duty to provide a safe working environment is paramount. Routinely check extension leads to ensure they are meeting the needs of electrical safety.",
        "Simple guide when loading adapters.",
        "Check the current rating of the extension lead before plugging appliances into it.",
        "Never overload an extension lead by plugging in appliances that together will exceed the maximum current rating stated for the extension lead.",
        "Only use one socket extension lead per socket and never plug an extension lead into another extension lead.",
        "Use an extension lead with multi sockets rather than a block adaptor",
        "Example: if a 4-way extension lead is rated at 10A, but you decide to plug in a space heater (8A), a TV (3A) and a mobile phone charger (2A) the total amount of amps in the extension lead is 13A and therefore is overloaded by 3A although there are only three appliances plugged in with one socket remaining."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s7-7-2-d",
    paragraph: {
      reference: "7.2.d)",
      subject: "Electrical sources of ignition",
      body: "Protected stairways are designed to provide virtually ‘fire sterile’ areas which lead to places of safety outside the building. Once inside a protected stairway, a person can be considered to be safe from immediate danger from flame and smoke. They can then proceed to a place of safety at their own pace. To enable this to be done, electrical installations should be enclosed in fire resisting construction.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s7-7-2-e",
    paragraph: {
      reference: "7.2.e)",
      subject: "Electrical sources of ignition",
      body: [
        "It is recommended that for all fixed heating systems, irrespective of the type of fuel, service contracts should be in place to ensure they are maintained in efficient and safe operation.",
        "It is recommended that facilities managers/RP’s conduct an audit of the heating requirements for their premises, considering what might be needed, both in extremely cold weather and/or when there are possible disruptions to utility supplies."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s7-7-2-f",
    paragraph: {
      reference: "7.2.f)",
      subject: "Electrical sources of ignition",
      body: "It is recommended that to prevent fires from occurring and in line with advice from, Fire & Rescue Services. R/Ps should remain vigilant for warning signs when using tumble dryers’ which include a smell of burning, textiles taking longer to dry, and dried items feeling hotter at the end of the cycle. You should carry out regular maintenance and cleaning of filters, and laundry room doors should be kept closed whenever the room is unoccupied.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s7-7-2-g",
    paragraph: {
      reference: "7.2.g)",
      subject: "Electrical sources of ignition",
      body: [
        "Confirmation is required that the PV panels conform to BS EN 61215 or BS EN 61646 in conjunction with BS EN 61730-1 and BS EN 61730-2 so that they may withstand inclement weather conditions and been manufactured and installed by a competent organisation.",
        "All maintenance should be undertaken strictly in accordance with the installer’s instructions on an annual basis by competent engineers familiar with the form of installation and with appropriate access equipment.",
        "Provisions for the fire and rescue service.",
        "Arrangements for firefighters to be met by security personnel or other designated staff.",
        "Suitable information provided for the fire and rescue service at a prominent location, such as the gatehouse.",
        "Switch provided in a readily accessible location on each installation to isolate the DC side of the PV system near the panels (a ‘fire service switch’) to ensure the safety of firefighting personnel.",
        "Is the isolation switch tested during routine maintenance visits, with the results being recorded?",
        "details of any automatic fire suppression system(s) and the location of their controls or valves.",
        "In the case of large installations, firefighters should be invited to visit the premises to familiarise themselves with the property and the locations of PV panels on the site",
        "To prevent the spread of fire, components of PV systems with combustible elements, e.g. cables, are not allowed to be passed over a compartment/fire wall. If this cannot be avoided, they should be installed in fire-resistant cable ducts and shafts"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s8-8-2-a",
    paragraph: {
      reference: "8.2.a)",
      subject: "Gas installation",
      body: [
        "The Gas Safety (Installation and Use) Regulations 1998 (GSIUR) It shall be the duty of every R/P, employer or self-employed person to ensure that any gas appliances, are safely installed, maintained and the use of any gas systems, including gas fittings, appliances and flues, (mainly in domestic and commercial premises, e.g. offices, shops, public buildings and similar places), that an effective maintenance schedule involves an ongoing programme of regular/periodic inspections, together with any necessary remedial work is carried out.",
        "Changes to the legislation",
        "The changes to GSIUR, which do not relax regulatory requirements or reduce safety standards, are to:",
        "introduce a degree of flexibility to the timing of landlords', property owners annual gas safety checks. This change means that landlords can conduct the annual gas safety check in the two months before the due date and retain the existing expiry date.",
        "This avoids landlords waiting until the last minute and not gaining access or having to shorten the annual cycle check to comply with the law. There is no change to the legal requirement for an annual gas safety check or for maintenance to be carried out"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s8-8-2-b",
    paragraph: {
      reference: "8.2.b)",
      subject: "Gas installation",
      body: [
        "The client should check with their insurers before approving the portable heaters use. Insurers may have requirements for the type of heaters permitted, and/or apply policy restrictions.",
        "Portable heaters should also be selected based on their compatibility with the environment they are to be used in e.g., where flammable gas, vapours or combustible dusts are present. Ensure you can site heaters as per the manufacturer’s instructions and in locations where they will not be subject to damage or being knocked over, and away from combustible materials."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s9-9-2-a",
    paragraph: {
      reference: "9.2.a)",
      subject: "Smoking",
      body: [
        "During the assessment there was evidence of smoking within the premises. It is recommended that a carefully monitored smoking policy is adopted which is likely to reduce the incidence of fires.",
        "It is therefore advisable to operate a safe smoking policy in a designated area outside the building, which complies with current regulations regarding smoking in public places.",
        "In areas where smoking is permitted, fixed or heavy based ashtrays should be provided in sufficient numbers and emptied regularly. This will also prevent unsuitable containers being used.",
        "All public buildings must display ‘No Smoking’ signs clearly throughout the building to ensure everyone is aware of this law. Many employers choose to place these signs around the entrance of their building, as non-smoking employees are often averse to walking through a cloud of smoke on their way to work."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s9-9-2-b",
    paragraph: {
      reference: "9.2.b)",
      subject: "Smoking",
      body: [
        "In determining any application for facilities for smokers the main issues to be considered will be:",
        "• Does the structure comply with the Smoke Free Premises etc. (Wales) Regulations 2007? i.e., is it a minimum of 50% open.",
        "• Will the location of the structure have an adverse impact on nearby residents or properties i.e., in terms of noise from customers or smoke drifting into Smoke Free areas or neighbouring properties.",
        "• Is the structure / canopy in keeping with its surroundings in terms of its visual impact. If the building is located within a Conservation Area or is a Listed Building, then extra care should be taken in the choice of structure.",
        "It is good practise to provide “cigarette disposal units” in smoking shelters to avoid unsightly cigarette waste and generally if located within the shelter themselves they will not require consent."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s9-9-2-c",
    paragraph: {
      reference: "9.2.c)",
      subject: "Smoking",
      body: [
        "A Policy Statement, outlines the No Smoking Policy and Procedure for the premises, organisation.",
        "The organisation should recognise that it has a duty to ensure, as far as is reasonably practical, that employees, agency workers, volunteers, contractors, and visitors have a right to live, work in or visit the premises without being exposed to tobacco smoke.",
        "The policy will be reviewed on a three yearly basis or more frequently if significant changes to its effective operation are necessary."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s9-9-2-d",
    paragraph: {
      reference: "9.2.d)",
      subject: "Smoking",
      body: [
        "Every person who controls or is concerned with the management of the smoke-free premises in Wales to which the smoke-free legislation applies needs to take steps to ensure that residents, employees, patients, customers, and other visitors do not smoke in premises and settings that are required to be smoke-free.",
        "There was evidence of illicit smoking found during a visit to your premises on … Insert Date…which is contrary to your smoking policy. You should, therefore, enforce the existing policy more rigidly or adapt your existing policy with further control measures. The option taken should be conveyed to all persons resorting to the premises.",
        "Actions that those with responsibilities under the legislation are advised to take.",
        "The minimum action that you are advised to take to ensure that your organisation complies with the legislation are to:",
        "display ‘No Smoking’ signs in smoke-free premises if required",
        "understand the duty to prevent smoking and take reasonable steps to prevent smoking in the smoke-free area",
        "In addition to the minimum actions required, we have set out extra information and advice on other actions which, may be considered to support all users of the smoke-free areas to adapt to the latest requirements."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s10-10-2-a",
    paragraph: {
      reference: "10.2.a)",
      subject: "Arson",
      body: [
        "An arson risk assessment should be carried out as part of the fire risk assessment procedure required by the Regulatory Reform (Fire Safety) Order 2005. As arson attacks are so common, such an exercise is a vital element of the fire risk assessment that is required by this legislation.",
        "The building manager or responsible person should ensure that they take the following precautions to reduce the threat from fire in their premises:",
        "Make regular checks on the premises – consider removing post from letterboxes and doorways as this can present an easy target for opportunistic fire setters.",
        "Remove any accumulated combustible items from around buildings",
        "Make regular checks of CCTV to identify any suspicious activity around the premises.",
        "Report accumulated or abandoned refuse to your local council.",
        "Report anti-social behaviour through your local neighbourhood policing team,",
        "Protect your commercial property. Seek advice on security, good lighting and CCTV will often act as a deterrent to the criminal.",
        "Take responsibility and think of ways in which someone could start a fire inside or outside of your property. Act on any issues you find."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s10-10-2-b",
    paragraph: {
      reference: "10.2.b)",
      subject: "Arson",
      body: "It is recommended that, an Arson Reduction Policy be implemented and should include means of controlling Refuse and flammable materials which should be removed regularly and placed outside in a secure closed metal container positioned, wherever possible, at least 10 metres from buildings and plant.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s10-10-2-c",
    paragraph: {
      reference: "10.2.c)",
      subject: "Arson",
      body: [
        "The control of visitors to your site is an important consideration of the arson assessment. If access to your premises is uncontrolled, unauthorised visitors may be able to access parts of the premises unseen and unchecked, allowing them to start fires in quieter parts of the premises, such as stock room areas.",
        "Visitor access to the premises should be via a single entrance with access control measures installed to prevent people being able to wander, unchecked, through buildings."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s11-11-2-a",
    paragraph: {
      reference: "11.2.a)",
      subject: "Portable heaters and heating and ventilation installations",
      body: [
        "The use of portable and transportable heaters in the workplace should be sanctioned",
        "by a designated person. This person should ensure that the use of such equipment is considered as part of the fire risk assessment undertaken to comply with fire safety legislation.",
        "Portable heaters should not be sited in the escape routes, circulation area even for a short period,"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s11-11-2-b",
    paragraph: {
      reference: "11.2.b)",
      subject: "Portable heaters and heating and ventilation installations",
      body: [
        "Where permanent background heating is required, it is safer, and potentially economical, to provide fixed rather than portable appliances – the use of portable heaters should be avoided wherever possible.",
        "Advice for using heaters safely",
        "All heaters",
        "Make sure heaters are well maintained and in good working order.",
        "Check that your heater isn't on a recall list – there have been many fires in the past year connected to heaters that have been recalled.",
        "Never install, repair or service appliances yourself.",
        "Don't take risks with old heaters – if it's electrical and getting older, get it tested by a qualified electrician or buy a new one.",
        "Where appropriate, secure heaters against a wall to stop them falling over, or fit wall-mounted heaters.",
        "Keep heaters well away from clothes, curtains and furniture and never use them for drying clothes.",
        "Always sit at least one metre away from a heater as it could set light to your clothes or chair.",
        "Before attempting to move your heater, turn it off and allow it to cool first.",
        "RC15%20Recommendations%20for%20the%20use%20of%20portable%20heaters%20in%20the%20workplace"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s11-11-2-c",
    paragraph: {
      reference: "11.2.c)",
      subject: "Portable heaters and heating and ventilation installations",
      body: [
        "Portable heaters should not be used for drying clothing, as clothing placed too near may fall to cover or knock a heater over. Where wet clothing is to be dried on a routine basis (such as on some construction sites), a purpose designed drying room should be provided.",
        "Or used in areas where flammable gases, vapours or combustible dusts may be present, unless they have been designed specifically for use in that type of environment."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s12-12-2-a",
    paragraph: {
      reference: "12.2.a)",
      subject: "Cooking",
      body: "it is recommended that inspections for grease build up and fire extinguishing systems at specified intervals be carried out, employees can be trained to inspect this equipment each day and management can be responsible for enforcing this expectation. Encourage employees to routinely look out for normal wear and tear of equipment (i.e., broken seals, missing screws, exposed wires).",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s12-12-b",
    paragraph: {
      reference: "12.b.)",
      subject: "Cooking",
      body: "Operators are to be made aware of and familiar with the location of the main isolator or shut off valves and the operation and correct method of use of portable fire extinguishing appliances and any fixed fire extinguishing system and appropriate signage in place.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s13-13-2-a",
    paragraph: {
      reference: "13.2.a)",
      subject: "Lightning",
      body: [
        "the UK doesn’t actually have laws specifying lightning protection for all buildings and structures. However, what it does have is a set of rules under the Electricity at Work Regulations 1989 that applies to businesses.",
        "Businesses are required to ensure that electrical installations and the business premises itself are protected from lightning strikes.",
        "In order to remain compliant with BS EN/IEC 62305, a company must have an inspection carried out by a licenced professional and invest in lightning mitigation installations such as surge protection to keep your electronic equipment safe and lightning rods to ground your building."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s14-14-2-a",
    paragraph: {
      reference: "14.2.a)",
      subject: "Housekeeping",
      body: "An assessment of existing housekeeping arrangements should be made to determine whether current procedures are satisfactory and that the necessary equipment and facilities are available. The use of suitable non-combustible portioning, barriers or floor markings can be highly effective in defining area’s or around potentially hazardous combustible materials.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s14-14-2-b",
    paragraph: {
      reference: "14.2.b)",
      subject: "Housekeeping",
      body: "A key step to fire prevention is general tidiness around the premises. Dispose of all waste properly into a designated bin store, eliminating a build-up of potentially flammable materials. Rubbish and waste can provide fuel for fire. Its proper handling and disposal are an important and integral part of the housekeeping process.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s14-14-2-c",
    paragraph: {
      reference: "14.2.c)",
      subject: "Housekeeping",
      body: [
        "Walkways and corridors must be kept clear of any debris as this could cause a trip hazard on an escape route. Occupants should adequately dispose of their rubbish and not leave items stored along means of escape passageways and in other inappropriate areas.",
        "This can increase the chances of a random arson attack and can also block off escape routes and egress into a building."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s14-14-2-d",
    paragraph: {
      reference: "14.2.d)",
      subject: "Housekeeping",
      body: [
        "Control of combustible materials should be achieved by attention to good housekeeping principles. By carefully considering the type of material, the quantities kept and the storage arrangements, risks can be significantly reduced. Appropriate practices are:",
        "not storing combustible materials in plant rooms, boiler rooms, attics, service voids and shafts, electrical main or subswitch rooms",
        "regular building checks to ensure that storage arrangements are appropriate"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s14-14-2-e",
    paragraph: {
      reference: "14.2.e)",
      subject: "Housekeeping",
      body: "There is key legislation around slips, trips, and falls, if you work in health and safety. Ensuring the health and safety of employees, and others, is not only moral and makes good business sense, but also the law. Slips, trips, and falls are a safety risk and can cause serious injury and even death. Health and safety laws are there to protect residents, workers, and others, and to give them an opportunity to seek restitutions if an RP fails in its duties.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s14-14-2-f",
    paragraph: {
      reference: "14.2.f)",
      subject: "Housekeeping",
      body: [
        "Landlords are bound by the Fire Safety Order to ensure the safety of their tenants by mitigating fire hazards and upkeeping escape routes. They carry a legal obligation to maintain common areas free of combustible materials and extend this duty to minimising specific risks within tenants' apartments, often by adhering to the relevant NFCC guidelines.",
        "It is recommend having some house rules for tenants keeping e-bikes or scooters, which tenants should sign at the same time as they sign their tenancy agreement. Also check your insurance to make sure that you are covered for damage from battery fires."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s14-14",
    paragraph: {
      reference: "14",
      subject: "Housekeeping",
      body: [
        "The FSO requires that a 'responsible person' must carry out, and keep up to date, a risk assessment and implement appropriate measures to minimise the risk to life and property from fire.",
        "The responsible person will usually be the main or principal contractor in control of the site."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s15-15-2-a",
    paragraph: {
      reference: "15.2.a)",
      subject: "Hazards introduced by outside contractors and building works",
      body: [
        "A permit to work system is a formal documented system, used to control high-risk activities. They are usually issued by a manager or supervisor and allow a person or group of people to carry out a task, under strict controls. Permits authorise certain staff members to carry out high-risk work at a specific time and place, providing that the procedures detailed in the permit and any referenced documents are followed.",
        "The purpose of a permit to work system is simply, to make high-risk tasks safer. In addition to a risk assessment and method statement, the permit to work is issued only to a particular person, at a specific time, authorising them to carry out the work under strict controls.",
        "In construction, permits to work are likely to be required for activities such as work to electrical systems, hot works, excavations, certain lifting operations, working at height and confined space works."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s15-15-2-b",
    paragraph: {
      reference: "15.2.b)",
      subject: "Hazards introduced by outside contractors and building works",
      body: [
        "It is important to remember that if you are the person (e.g., designer, builder, installer) carrying out building work to which any requirement of Building Regulations applies you have a responsibility to ensure that the work complies with any such requirement. The building owner may also have a responsibility for ensuring compliance with Building Regulation requirements and could be served with an enforcement notice in cases of non-compliance.",
        "You should ensure that, before any building work starts, you have reviewed the fire risk assessment and considered what additional dangers are likely to be introduced. You should continuously monitor the impact of the building work on the general fire safety precautions, such as the increased risk from quantities of combustible materials and accumulated waste and maintaining adequate means of escape."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s16-16-2-a",
    paragraph: {
      reference: "16.2.a)",
      subject: "Dangerous substances and materials",
      body: [
        "When considering the storage of flammable liquids, alongside all the normal measures associated with storing liquids there are strict rules concerning separation distances. This is the distance the flammable liquids must be stored from occupied buildings, boundaries, process units, flammable liquid storage tanks and or sources of ignition.",
        "Quantity Stored",
        "Distance",
        "Up to 1,000ltr",
        "2 metres",
        "1,000 up to 100,000ltr",
        "4 metres",
        "Above 100,000ltr",
        "7.5 metres"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s16-16-2-b",
    paragraph: {
      reference: "16.2.b)",
      subject: "Dangerous substances and materials",
      body: [
        "Guidance on separation distances is provided in various HSE Codes of Practice such as HS(G)51 Storage of flammable liquids in containers Where separation distances are inadequate measures such as firewalls can be employed to reduce the impact of incidents",
        "What approved Codes of Practice apply to the Safe Storage of LPG?",
        "I.S. 3213: Code of Practice for the Storage of LPG Cylinders and Cartridges"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s16-16-2-c",
    paragraph: {
      reference: "16.2.c)",
      subject: "Dangerous substances and materials",
      body: [
        "Private oil storage tanks benefit homes and business all across the UK. However, with these comes the responsibility of ensuring that your tank is properly positioned and maintained to prevent it from becoming a fire hazard. You must follow the rules on storing oil if you’ve got an oil storage container with a capacity of 201 litres or more at a:",
        "business, including marinas",
        "public sector building like a school, hospital, or leisure centre",
        "You must follow the rules on storing oil if you’ve got an oil storage container with a capacity of 201 litres or more at a:",
        "business, including marinas",
        "public sector building like a school, hospital, or leisure centre",
        "You must also follow these rules if you’ve got an oil storage container with a capacity of 3,501 litres or more at a home, including barges and houseboats.",
        "Storage containers include:",
        "oil drums and fixed tanks",
        "intermediate bulk containers (IBCs)",
        "mobile bowsers – containers designed to store and dispense oil that can be moved between locations but not under their own power",
        "some types of generators",
        "You could be fined or prosecuted if you do not follow the requirements in this guide. The Environment Agency can also serve an anti-pollution works notice to make you bring your oil store up to legal standards.",
        "(See supporting evidence for further info)",
        "https://www.gov.uk/guidance/storing-oil-at-a-home-or-business"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s17-17-2-a",
    paragraph: {
      reference: "17.2.a)",
      subject: "Flammable, combustible items and other dangerous materials",
      body: [
        "A tenant, has the right to expect that furniture, in rented furnished accommodation are safe. The landlord is legally responsible for ensuring these products meet safety standards, although they may have contracted the management of the accommodation to a letting agent.",
        "There are specific safety regulations that cover certain types of products. For all other products, both new and second-hand, the General Product Safety Regulations 2005 apply."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s17-16-2-b",
    paragraph: {
      reference: "16.2.b)",
      subject: "Flammable, combustible items and other dangerous materials",
      body: [
        "the Furniture and Furnishings (Fire) (Safety) Regulations 1988 set out requirements for the safety of any upholstered furniture supplied. These Regulations were introduced to reduce the number of people killed and injured by toxic fumes given off when some upholstery materials burn. They cover any furniture that includes upholstery (unless it was made before 1950) - for example:",
        "sofas and armchairs",
        "beds, headboards, and mattresses",
        "sofa-beds, futons, and other convertibles",
        "nursery and children's furniture (including pushchairs and prams)",
        "loose and stretch covers for furniture",
        "scatter cushions, seat pads and pillows",
        "furniture in new caravans",
        "garden furniture that can be used indoors",
        "(See supporting evidence for further info)"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s18-18",
    paragraph: {
      reference: "18",
      subject: "Construction — floors, walls, ceilings, glazing and stairs",
      body: [
        "Once you have conducted a suitable fire risk assessment, where necessary, you may then need to plan for what’s known as fire compartmentation, or an active or passive fire protection survey.",
        "It’s important to understand that Passive Fire Precautions (PFP) are a vital part of the building fabric, dividing the building into individual fire compartments, constructed, and lined with suitable fire resisting materials to reduce the spread of fire.",
        "What is the purpose of Fire Compartmentation?",
        "Prevent rapid spread of fire and smoke",
        "Subdivide buildings into manageable areas of risk",
        "Provide and protect adequate Means of Escape",
        "Provisions in statutory guidance documents",
        "Control fire size by managing the amount of fuel available",
        "Correctly implemented fire stopping involves dividing an area into sections, which in turn allows the fire to be contained into one area of the building. This then allows fire crews to safely extinguish the fire whilst it is contained.",
        "Different types of fire compartmentation",
        "Fire Compartmentation takes different forms in a building and done correctly, should be designed before the building is constructed and identified in the Fire Strategy, this is a requirement of the Building Regulations. Once constructed the elements of fire compartmentation should be routinely assessed and maintained properly. Types of compartmentation"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s18-18-2-a",
    paragraph: {
      reference: "18.2.a)",
      subject: "Construction — floors, walls, ceilings, glazing and stairs",
      body: [
        "The spread of fire can be restricted by sub-dividing buildings into a number of discrete compartments. These fire compartments are separated from one another by floors made of a fire-resisting construction which hinders the spread of fire.",
        "Approved document B defines a compartment wall or floor as a '...fire-resisting wall/floor used in the separation of one fire compartment from another.'",
        "Fire compartmentation:",
        "Every compartment floor should:",
        "a. form a complete barrier to fire between the compartments they separate.",
        "b. have the appropriate fire resistance"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s18-18-2-b",
    paragraph: {
      reference: "18.2.b)",
      subject: "Construction — floors, walls, ceilings, glazing and stairs",
      body: [
        "Compartment walls and compartment floors form a complete barrier between fire compartments and are required to provide a minimum degree of fire resistance as set out in Appendix A of Approved document B2.",
        "Joints between fire-separating elements such as compartment walls or floors, should be fire-stopped to maintain the continuity of resistance, and openings for timber beams, joists, purlins, and rafters.",
        "Compartment walls that are common to two or more buildings should run the full height of the building in a continuous vertical plane. Thus, adjoining buildings should only be separated by walls, not floors. Compartment walls in a top storey beneath a roof should be continued through the roof space"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s18-18-2-c",
    paragraph: {
      reference: "18.2.c.)",
      subject: "Construction — floors, walls, ceilings, glazing and stairs",
      body: [
        "If a fire-separating element is to be effective, then every joint, or imperfection of fit, or opening to allow services to pass through the element, should be adequately protected by sealing or fire-stopping so that the fire resistance of the element is not impaired.",
        "Pipes, ducts, conduits, or cables that pass through any part of a fire-separating element should be kept as few as possible, kept as small as practicable; and should be fire-stopped.",
        "Approved document B V1, defines a fire stop as: ‘A seal provided to close an imperfection of fit or design tolerance between elements or components, to restrict the passage of fire and smoke.'"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s18-18-2-d",
    paragraph: {
      reference: "18.2.d)",
      subject: "Construction — floors, walls, ceilings, glazing and stairs",
      body: [
        "There are a number of additional requirements depending on the type of building.",
        "Parts of a building that are occupied for different purposes should generally be separated from one another by compartment walls and compartment floors.",
        "Your Fire Risk Assessor will have recommended a fire compartmentation survey following a Fire Risk Assessment that identified numerous breaches in fire compartment walls, ceilings and floors.",
        "A structural survey is to be carried out to determine the extent of the voids and cavities running throughout the premises. In the event of fire, these voids and cavities will allow fire and smoke to spread unchecked throughout the building. This would have an impact on the means of escape provision for the building.",
        "A fire compartmentation survey with will include looking into roof spaces, floor voids, behind boxing and more. Essentially, any space into which a fire can spread will be identified and a fire compartmentation survey will provide resultant fire protection recommendations, or in more serious circumstances, obligatory instructions that must be adhered to comply with Fire safety Legislation."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s18-18-2-e",
    paragraph: {
      reference: "18.2.e)",
      subject: "Construction — floors, walls, ceilings, glazing and stairs",
      body: "Fire-resistant glazing can be used to ensure that – along with other elements such as walls and doors – fire and smoke does not spread to other parts of a building for a prescribed period. It can be used to provide fire separation or compartmentation as part of an integrated fire safety strategy.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s18-18-2-f",
    paragraph: {
      reference: "18.2.f)",
      subject: "Construction — floors, walls, ceilings, glazing and stairs",
      body: "Stairs provide a potential route for fire spread from floor to floor. Common stairs need to have a satisfactory standard of fire protection if they are to fulfil their role as areas of relative safety during a fire evacuation. Every common stair should be situated within a fire-resisting enclosure (i.e., it should be a protected stairway), to reduce the risk of smoke and heat making use of the stair hazardous.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s18-18-2-g",
    paragraph: {
      reference: "18.2.g)",
      subject: "Construction — floors, walls, ceilings, glazing and stairs",
      body: [
        "Final exits need to be dimensioned and sited to facilitate the evacuation of persons out",
        "of and away from the building. Accordingly, they should be not less in width than the",
        "minimum width required for the escape route(s) they serve and should also meet the",
        "conditions in paragraphs 6.31 to 6.34 of Approved Document B Volume 2"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s18-18-2-h",
    paragraph: {
      reference: "18.2.h)",
      subject: "Construction — floors, walls, ceilings, glazing and stairs",
      body: [
        "Options",
        "BS 9999 2017 Fire safety in the design, management, and use of buildings – Code of practice",
        "To the ………. Insert location…. of the property from the ……Insert floor numbers…. floor an external metal escape stair has been installed. BS 9999 2017 states; where more than one escape route is available from a storey or part of a building, one or more of the escape routes from the storey or part of the building may be by way of an external escape stair, provided that there is at least one internal escape stair from every part of each storey. provided that the following measures are incorporated.",
        "a) All doors giving access to the external stair should be fire-resisting and self-closing, except that a fire-resisting door is not needed at the head of any stair.b) Any part of the external walls within 1800 mm of the flights and landings of an external escape stair should be of fire-resisting construction.c) Any part of the building (including any doors) within 1800 mm of the escape route from the stair to a place of relative or ultimate safety should be provided with protection by fire-resisting constructiond) Glazing in areas of fire-resisting construction [see c] should also be fire-resisting to meet the criteria for both integrity and insulation and should be fixed shut.e) Where a stair is more than 6 m in vertical extent it should be protected from the effects of adverse weather conditions.",
        "NOTE A full enclosure is not necessary. The extent of enclosure needed depends on the location of the stair and the degree of protection given to the stair by the building itself. Trace heating is acceptable but needs to be maintained throughout the life of the building and be treated to the same standard as emergency escape lighting and provided with thermostatic control to operate in cold weather.",
        "External escape Approved Document B Volume 2",
        "Where an external escape stair is provided in accordance with Approved Document B Volume 1 Paragraph 3.15 also Approved Document B Volume 2 paragraph 5.44, it should meet the following provisions:",
        "a. all doors giving access to the stair should be fire-resisting and self-closing, except that a fire-resisting door is not required at the head of any stair leading downwards where there is only one exit from the building onto the top landing.",
        "b. any part of the external envelope of the building within 1800mm of (and 9m vertically below), the flights and landings of an external escape stair should be of fire-resisting construction, except that the 1800mm dimension may be reduced to 1100mm above the top level of the stair if it is not a stair up from a basement to ground level (see Diagram 25).",
        "c. there is protection by fire-resisting construction for any part of the building (including any doors) within 1800mm of the escape route from the stair to a place of safety, unless there is a choice of routes from the foot of the stair that would enable the people escaping to avoid exposure to the effects of the fire in the adjoining building.",
        "d. any stair more than 6m in vertical extent is protected from the effects of adverse weather conditions. (This should not be taken to imply a full enclosure. Much will depend on the location of the stair and the degree of protection given to the stair by the building itself); and",
        "e. glazing in areas of fire-resisting construction mentioned above should also be fire resisting (integrity but not insulation) and fixed shut."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s18-18-2-i",
    paragraph: {
      reference: "18.2.i)",
      subject: "Construction — floors, walls, ceilings, glazing and stairs",
      body: [
        "A compartment wall should be taken up to meet the underside of the roof covering or deck, with fire-stopping where necessary at the wall/ roof junction to maintain the continuity of fire resistance. The compartment wall should also be continued across any eaves.",
        "It is recommended that a full compartment survey is carried out. The objective of which will typically involve a review of existing fire compartment measures. A fire compartmentation is a more detailed survey, sampling can indicate the presence of significant issues, such as locating or confirming the presence of fire stopping or establishing if existing measures meet the requirements of current guidance or to meet other specific objectives."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s18-18-2-j",
    paragraph: {
      reference: "18.2.j)",
      subject: "Construction — floors, walls, ceilings, glazing and stairs",
      body: [
        "BS 9999 covers a wide range of fire safety best practices, aimed at helping architects, surveyors, facilities professionals, fire safety engineers and consultants to provide a safe environment for people in and around buildings.",
        "Part of this standard addresses the need for all ducting to be fitted with fire dampers at regular intervals.",
        "There are a variety of fire dampers in use across the UK, but there are two ways fire dampers are operated:",
        "1. By a fusible link which is triggered at certain temperatures, releasing the damper to close 2. Electronically, by linking the fire damper to the buildings central fire safety system.",
        "BS 9999 requires that all dampers, regardless of type, specification or operation method are tested annually as a minimum.",
        "There are a few keys elements to testing, which can be summarised as:",
        "Identification – finding the location of dampers in your building",
        "Inspection – a visual check of the installation and state of repair",
        "Testing – a physical fire damper drop test",
        "Resetting – replacing the fire damper to its ‘ready’ state",
        "Reporting – an essential element for compliance is the maintenance of compressive records"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s18-18-2-k",
    paragraph: {
      reference: "18.2.k)",
      subject: "Construction — floors, walls, ceilings, glazing and stairs",
      body: [
        "Materials used to line walls and ceilings can contribute significantly to the spread of flame",
        "across their surface. Most materials that are used as surface linings will fall into one of three classes",
        "of surface spread of flame. The surface materials used on walls/ceilings located …insert location…is considered to be unacceptable. Upgrading is necessary to comply with the Class 0,1,3 surface spread of flame."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s18-18-2-l",
    paragraph: {
      reference: "18.2.l)",
      subject: "Construction — floors, walls, ceilings, glazing and stairs",
      body: "Where an external escape route, other than a stair, is beside an external wall of the building, that part of the external wall within 1.8 m (measured horizontally) of the escape route should be of fire-resisting construction 1.1 m above the level of the route.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s18-18-2-m",
    paragraph: {
      reference: "18.2.m)",
      subject: "Construction — floors, walls, ceilings, glazing and stairs",
      body: "The fire resistance of a wall depends on its distance from the relevant boundary if this cannot be achieved then separating wall with minimum fire resistance duration (60 minutes) should be provided between adjoining dwellings.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s19-19-2a",
    paragraph: {
      reference: "19.2a)",
      subject: "Means of escape",
      body: [
        "If possible, more than one fire exit is recommended. All fire exit doors need to be completely independent of each other, with distinct escape routes that provide multiple opportunities to evacuate the building.",
        "Where only a single escape route is provided:",
        "12m in higher fire-risk area.",
        "18m in normal fire-risk area.",
        "25m in lower fire-risk area.",
        "Where more than one escape route is provided:",
        "25m in higher fire-risk area.",
        "45M in normal fire-risk area.",
        "60m in lower fire-risk area.",
        "It’s not always going to be possible to provide more than one fire exit, for instance in small buildings or irregular heritage structures. In these scenarios, the guidance says that there should be no point more than 25 metres away from the main fire exit"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s19-19-2-b",
    paragraph: {
      reference: "19.2.b)",
      subject: "Means of escape",
      body: [
        "The number, distribution and dimensions of emergency routes and exits available are not considered adequate having regard to the use, equipment and dimensions of the premises and the maximum number of persons who may be present there at any one time.",
        "This should be remedied by the provision of additional/alternative exits/routes, from the following areas…… list areas of concern…..."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s19-19-2-c",
    paragraph: {
      reference: "19.2.c)",
      subject: "Means of escape",
      body: "The final exits on an escape route may or may not be located on the usual route of traffic when the premises are operating under normal circumstances.  The final exit doors should open easily, immediately and, wherever practicable, “in the direction of escape”, i.e., outwards into a place of safety outside the building. Sliding or revolving doors must not be used for exits specifically intended as fire exits.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s19-19-2-d",
    paragraph: {
      reference: "19.2.d)",
      subject: "Means of escape",
      body: [
        "The use of fire-resisting elements to separate the building into compartments and to protect escape routes is an important feature of the recommendations for the provision of openings in such separating elements and the avoidance of fire and smoke spread through them.",
        "Fire doors have at least one of two functions:",
        "a) to protect escape routes from the effects of fire so that occupants can reach a final exit.",
        "b) to protect occupants, fire-fighters, and the contents and/or structure of a building by limiting the spread of fire.",
        "Fire resisting doors opening on to the means of escape should be fitted with:",
        "A positive action self-closing device. Doors to storerooms need not be fitted with a self-closing device providing that they are kept locked shut when not in use.",
        "Intumescent strips and smoke seals.",
        "Three brass/steel hinges."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s19-19-2-e",
    paragraph: {
      reference: "19.2.e)",
      subject: "Means of escape",
      body: "Protected escape routes are designed to provide virtually ‘fire sterile’ areas which lead to places of safety outside the building. Once inside a protected route, a person can be considered to be safe from immediate danger from flame and smoke. They can then proceed to a place of safety at their own pace. To enable this to be done, electrical installations should be enclosed in fire resisting construction.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s19-19-2-f",
    paragraph: {
      reference: "19.2.f)",
      subject: "Means of escape",
      body: [
        "Flat entrance doors are required to be fire doors. Fire doors and escape routes BS 9999 Fire safety in the design, management, and use of buildings – Code of practice sets out the following standards:",
        "Every flat within a block of flats or HMO should have a fire door fitted at the entrance onto the communal area. Flats located on floors 4.5m above ground level must have a fire rated door fitted between all habitable rooms as well as the front door. Ground floor flats do not usually need internal fire doors as long as each room has an accessible way to escape. They do still need a fire door to be fitted at the entrance if the front door opens onto a communal area such as a corridor."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s19-19-2g",
    paragraph: {
      reference: "19.2g)",
      subject: "Means of escape",
      body: [
        "Self-closing devices Fire doors can only operate correctly if they are fully closed at the time of fire. As a result, all fire doors, except those leading to a cupboard or service duct (both of which are normally kept locked shut) and with the exception of lift landing doors, should be fitted with a self-closing device",
        "Self-closing fire doors are more likely to be propped open, and thus rendered ineffective, by the occupants of a building if the doors are regarded as an impediment to access. Poorly specified self-closing devices can make fire doors virtually impassable to some people, e.g., wheelchair users and those with limited upper body strength."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s19-19-2-h",
    paragraph: {
      reference: "19.2.h)",
      subject: "Means of escape",
      body: "The provision of smoke control in the means of escape is inadequate, smoke control systems should be designed and maintained so as to remove a sufficient volume of smoke in order to protect the structure, the contents, the means of escape, or to assist fire-fighting operations.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s19-19-2-i",
    paragraph: {
      reference: "19.2.i)",
      subject: "Means of escape",
      body: [
        "In All Premises escape routes should be kept clear of all obstructions. Generally, escape routes should be at least one metre wide. The escape route should lead to a place of safety, normally outside and away from the building. Doors on escape routes must always be available for use without the use of a key.",
        "When considering the escape routes from a place of work, a responsible person must be sure that that they have evaluated the entire journey to a place of safety. All routes must be kept clear, including areas outside the premises that are included in the escape route."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s19-19-2-j",
    paragraph: {
      reference: "19.2.J)",
      subject: "Means of escape",
      body: "The security devices fitted to fire exit doors should be removed. The door should be fitted with one approved emergency exit device only. Where a second fastening is fitted it must either be removed, or a robust management procedure put in place to ensure that secondary locks are removed. The door should be fitted with a thumb turn type lock. The operation of the fastenings should be readily apparent without the use of a key and without having to manipulate more than one mechanism. Whilst this will be acceptable for use by limited numbers it should have a notice adjacent indicating how its mode of operation.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s19-19-2-k",
    paragraph: {
      reference: "19.2.k)",
      subject: "Means of escape",
      body: [
        "The responsible person should devise a suitable emergency evacuation plan for all people likely to be in the premises, including disabled people, and how that plan will be implemented. Further guidance is available in H.M Government publication ‘supplementary guide - means of escape for disabled people.’",
        "The evacuation plan should not rely upon the intervention of the fire and rescue service to make it work.",
        "You may need to develop individual ‘personal emergency evacuation plans’ (PEEPs) for disabled people who frequently use a building. They will need to be confident of any plan/PEEP that is put in place after consultation with them.",
        "If members of the public use your building, then you may need to develop a range of standard PEEPs which can be provided on request to a disabled person or others with special needs. Guidance on removing barriers to the everyday needs of disabled people is available in British Standard 8300:2009, A1:2010 Design of buildings and their approaches to meet the needs of disabled people – Code of practice."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s19-19-2-l",
    paragraph: {
      reference: "19.2.l)",
      subject: "Means of escape",
      body: "Fire doors not only prevent the spread of fire, but they also provide an important barrier to smoke. A fully closed fire door can help protect people from the dangers of fire for more than half an hour, allowing critical time to escape or seek refuge, and provide a safe and protected route into the building for emergency services. No matter how good a fire door is at doing its job, it is rendered useless if it is wedged open.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s19-19-2-m",
    paragraph: {
      reference: "19.2.m)",
      subject: "Means of escape",
      body: "Ask your fire door manufacturer for their recommended threshold gap. If this information is not available, it seems reasonable to permit a gap of up to 8mm for general fire doors (e.g., FD30). If you have a requirement for cold smoke control (e.g., FD30s) your threshold gap should be 3mm or less, or you should fit a threshold smoke seal (most commonly in the form a drop-down seal).",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s19-19-2-n",
    paragraph: {
      reference: "19.2.n)",
      subject: "Means of escape",
      body: [
        "It is not always practical to have your fire doors closed at all times as this can hamper the movement of people and equipment around your premises. Corridors experiencing high footfall are especially likely to need a means of allowing fire doors to be held open to enable people to pass through or for air to circulate.",
        "There are devices available that allow fire doors to be held open legally. Fire door retainers hold the doors in the open position (against the pressure from the door closer) and release the door in the case of a fire, allowing the door closer to shut the door."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s20-20-2a",
    paragraph: {
      reference: "20.2a)",
      subject: "External cladding",
      body: [
        "It is recommended that a Fire Risk Appraisal of External Walls (FRAEW) be carried out to assess the risk to occupants from a fire spreading over or within the external walls of the building, and to decide as to whether, in the specific circumstances of the building, remediation or other mitigating measures to address the risk are considered necessary.",
        "It is applicable where the risk is known, or suspected, to arise from the form of construction used for the external wall buildup, such as the presence of combustible materials. The outcome of an FRAEW is intended to inform fire risk assessments (FRAs) of multistorey, multioccupied residential buildings."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s20-20-2-b",
    paragraph: {
      reference: "20.2.b)",
      subject: "External cladding",
      body: "A notable feature of external walls, and especially modern cladding systems such as a rainscreen cladding system, is the presence of cavities. These present the particular danger of concealed and extensive fire spread. As well as contributing to the speed of fire development, this mechanism for fire spread can, if not properly mitigated by cavity barriers, circumvent key features in the building’s fire safety design. Most notably, in the case of a block of flats, this can allow the compartmentation between floors and between flats to be bypassed. It is recommended that the type, location, and condition of cavity barriers, where relevant, should also be included in the FRAEW.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s20-20-2-c",
    paragraph: {
      reference: "20.2.c)",
      subject: "External cladding",
      body: [
        "Cavity barriers are inert fire protection components that inhibit smoke and flames from dispersing through the walls. Older buildings may not have been constructed to meet this industry standard or may have been constructed before this stipulation was mandatory. Because of this, the fire preventing provision and compartmentation of cavity barriers should be reviewed as part of the fire risk evaluation procedure by an accredited and qualified fire safety company. It is not uncommon for external walls to be examined by building surveyors, architects, façade engineers and others in order to establish factual information on the materials, components, and systems.",
        "As cavity barriers are typically hidden by the progress of the construction process, it is critical that final as built and maintenance information is collated and included in the building fire safety manual, to facilitate Dame Hackitt’s ‘golden thread’ preserving original design intent."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s20-20-2-d",
    paragraph: {
      reference: "20.2.d)",
      subject: "External cladding",
      body: [
        "Options",
        "i. The balconies and terraces on the property are located adjacent to, above or below combustible building construction, the Client should Consider:",
        "• Walls, external cladding, and wall insulation",
        "• Wall coverings, such as living walls",
        "• Other building features, such as gutters, downpipes, facia boards, soffits, and roof overhangs",
        "• Combustible roofs and living roofs",
        "ii. The balconies/terraces themselves are constructed of combustible materials?",
        "• Decking, frame, joists, cassettes, soffits, balustrades, and handrails, etc.",
        "If unknown, seek professional advice.",
        "iii. A management policy should be implemented to prohibit the following high fire risk activities on balconies and terraces:",
        "• Barbeques?",
        "• All forms of cooking?",
        "• Heaters/chimineas?",
        "• Firepits?",
        "• Smoking?",
        "• Candles and related items, e.g., oil lamps?"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s21-21-2-a",
    paragraph: {
      reference: "21.2.a)",
      subject: "Emergency escape lighting",
      body: [
        "Routine inspections and tests of the emergency lighting system should be undertaken based on BS 5266: Part 8 which, among other things, indicates that tests should, wherever possible, be undertaken at time of minimum risk, and associated with inspections, at frequencies as follows:",
        "Daily check.",
        "Monthly test.",
        "Subsequent Annual Test.",
        "The date of all such tests and any resulting maintenance of the emergency lighting system should be recorded in a logbook with the exception of the daily test, where there are no faults or repairs found."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s21-21-2-b",
    paragraph: {
      reference: "21.2.b)",
      subject: "Emergency escape lighting",
      body: [
        "The requirement for emergency lighting depends on the type and features of the building. Once it is installed it is necessary to conduct the relevant inspections and checks to maintain efficacy. Emergency lighting is part of the fire safety provision of a building the client should Install an emergency lighting system to the relevant standard to cover:",
        "Common area’s.",
        "Toilets.",
        "Exits and routes to exit.",
        "Outside of exits and routes around the building where there is no benefit from street lighting.",
        "For a relevant standard please refer to BS5266 Pt 1 Emergency lighting code of practice for emergency lighting of premises. Compliance with this or an equivalent standard will normally satisfy the requirement."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s21-21-2-c",
    paragraph: {
      reference: "21.2.c)",
      subject: "Emergency escape lighting",
      body: [
        "Suitable lighting should be provided to all parts of the premises to enable the safe movement of persons along escape routes to a place of relative or ultimate safety.",
        "Emergency lighting luminaire should be sited where possible two metres from the ground, or as close to it as the building design allows, but no lower than 2 metres. The escape route must be uniformly lit. The emergency lighting luminaire should also be around 2 metres from any of the below features when measured horizontally.",
        "Corridor intersections.",
        "Above each final exit door.",
        "Near each change of direction.",
        "Within each stairway.",
        "Near any change in floor level.",
        "Outside any secondary escape exit if the street lighting is poor.",
        "Near each alarm call point.",
        "Near firefighting equipment."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s21-21-2-d",
    paragraph: {
      reference: "21.2.d)",
      subject: "Emergency escape lighting",
      body: "External areas in the immediate vicinity of exits Emergency illumination should be provided outside the building and near to each final exit. If occupants have to travel to reach a place of safety, this route should form an integral part of the escape route. Existing installations may use external street lighting to illuminate external exits (borrowed lighting). These should be assessed to confirm whether the streetlights will still be illuminated at all times the premises is in use; if they will not, alternative arrangements should be made.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s21-21-2-e",
    paragraph: {
      reference: "21.2.e)",
      subject: "Emergency escape lighting",
      body: [
        "Adequate artificial lighting should be provided in all common escape routes and should be of a sufficient standard to enable persons to see to escape and conform to the appropriate recommendations of BS 5266: Part 1",
        "In addition to the system of artificial lighting, escape lighting should be provided within:",
        "windowless accommodation normally accessible to the occupants,",
        "windowless common stairs,",
        "internal common corridors exceeding 30m in length,",
        "common stairs in buildings higher than 18m,",
        "all common escape routes in sheltered housing,",
        "common escape routes across a flat roof."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s22-22-2-a",
    paragraph: {
      reference: "22.2.a)",
      subject: "Fire safety signs and notices",
      body: "Fire Door Keep Shut sign ensures that your premises comply with British Legislation. All fire doors in your premises need to be marked with signs which enable people to easily identify them as fire doors and to notify staff and visitors that the doors need to be kept shut.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s22-22-2-b",
    paragraph: {
      reference: "22.2.b)",
      subject: "Fire safety signs and notices",
      body: "A Fire Door Keep Locked Symbolised Sign is a mandatory message which is to be mounted onto fire doors around areas where it is required that the fire doors must be kept locked and conveys the message \"Fire door keep locked\" meaning it is mandatory that the door must be kept locked.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s22-22-2-c",
    paragraph: {
      reference: "22.2.c)",
      subject: "Fire safety signs and notices",
      body: "Push Bar/pad To Open Signs are to be used for the purpose of mounting onto doors which have push bar/pad operating mechanisms. Doors featuring security devices, such as push to release opening mechanisms and sliding mechanisms, and doors which are specifically used for emergency escape, should all use safety signs to demonstrate their opening instructions.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s22-22-2-d",
    paragraph: {
      reference: "22.2.d)",
      subject: "Fire safety signs and notices",
      body: "Fire escape signs should be provided to guide you from wherever you are in a building, via a place of relative safety (the escape route) to the place of ultimate safety (the assembly area). Fire escape signs are not needed on the main route into or out of a building (the one used by people for normal arrival and exit), but alternative escape routes and complicated escape routes do need to be signed.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s22-22-2-e",
    paragraph: {
      reference: "22.2.e)",
      subject: "Fire safety signs and notices",
      body: "Escape route location signs are signs that identify the direction of travel to escape or exit a building. They indicate doorways and openings that will lead you to a place of safety, in order to make an evacuation as quick, simple, and efficient as possible. These signs should be in pictorial form of a man running through a fire door with the words ‘Fire Exit’ and should be placed to indicate every change of direction and or level.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s22-22-2-f",
    paragraph: {
      reference: "22.2.f)",
      subject: "Fire safety signs and notices",
      body: "Outside the final exit if the door can be obstructed a “Fire Exit Keep Clear” sign is needed on the outside of the door. The client may wish to consider bollards and/or yellow hatching paint directly outside the final escape.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s22-22-2-g",
    paragraph: {
      reference: "22.2.g)",
      subject: "Fire safety signs and notices",
      body: [
        "The Fire Action Notice’s purpose is to make sure that anyone working/residing in or visiting your premises knows what to do if they discover a fire or if they need to evacuate the building.",
        "These are usually pre-printed signs with information such as:",
        "The action to take in case of fire",
        "Where the assembly point is",
        "Any additional instructions specific to the building.",
        "There are different types of fire action signs. You should install one which summarises the premises fire strategy/action to take in case of fire. Best practice guidelines recommend that you display a Fire Action Notice next to Fire Alarm call-point (s) and at every final exit door, where they are most likely to be seen in the event of fire."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s23-23-2-a",
    paragraph: {
      reference: "23.2.a)",
      subject: "Means of giving warning in case of fire",
      body: "An electrical fire warning system should be provided, the installation to conform to BS 5839: Part 1. All work involving the fire alarm should be carried out in accordance with the relevant standard, installed and commissioned by a competent certificated organisation.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s23-23-2-b",
    paragraph: {
      reference: "23.2.b)",
      subject: "Means of giving warning in case of fire",
      body: "The installation of smoke alarms, or automatic fire detection and alarm systems can significantly increase the level of safety by automatically giving an early warning of fire. BS 5839-6 or Part 1 is the key standard for fire detection in domestic premises. The standard is used by architects and other building professionals, enforcing authorities, installers, and contractors, and applies to domestic premises accommodating single families, houses in multiple occupation (HMOs) and sheltered housing (housing and common areas).",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s23-23-2-c",
    paragraph: {
      reference: "23.2.c)",
      subject: "Means of giving warning in case of fire",
      body: "It is essential that fire detection and fire alarm systems are properly designed, installed, and maintained. Where a fire alarm system is installed, an installation and commissioning certificate should be provided. Third party certification schemes for fire protection products and related services are an effective means of providing the fullest possible assurances, offering a level of quality, reliability, and safety.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s23-23-2-d",
    paragraph: {
      reference: "23.2.d)",
      subject: "Means of giving warning in case of fire",
      body: "The existing fire warning system should be modified/extended or replaced as necessary to conform fully to BS 5839: Part 1: Category *insert category. An L1 fire alarm system provides the highest standard for protection of life. Fire alarm detectors are installed in all rooms and areas of the building, including roof spaces and voids. Some areas need not be protected if they are of low fire risk such as stairways, lobbies, and small cupboards. All work involving the fire alarm should be installed and commissioned by a competent certificated organisation.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s23-23-2-e",
    paragraph: {
      reference: "23.2.e)",
      subject: "Means of giving warning in case of fire",
      body: "Fire alarm systems are installed to protect you if there is a fire. Tampering with or adversely affecting the efficiency of a fire detection systems may be considered a criminal offence and the fire authorities may decide to prosecute you.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s23-23-2-f",
    paragraph: {
      reference: "23.2.f)",
      subject: "Means of giving warning in case of fire",
      body: [
        "The existing fire alarm system should be extended to provide additional break glass call points. Usually located along the escape routes, near the fire exits, so that you can trigger the alarm without slowing down the evacuation process or putting yourself in unnecessary danger. According to the relevant regulatory requirements (BS 5839), call points should be placed:",
        "On each floor of a building",
        "No more than 30 metres from any point in the building",
        "No higher than 1.4 metres above the floor",
        "In a visible & accessible location",
        "Additionally, in areas identified as high-risk"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s23-23-2-g",
    paragraph: {
      reference: "23.2.g)",
      subject: "Means of giving warning in case of fire",
      body: "Manual activation devices such as fire alarm call points and door release access control points are essential for both systems and need to be used in the event of an emergency. They should be readily available and free from obstruction.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s23-23-2-h",
    paragraph: {
      reference: "23.2.h)",
      subject: "Means of giving warning in case of fire",
      body: "A fire alarm zone plan is a diagrammatic representation of your building, listing all of its zones the layout should clearly show common escape routes, circulation areas. It also shows the building exits, stairs and should be located next to the fire alarm panel. It can immediately identify where any potential fire situation may have occurred.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s23-23-2-i",
    paragraph: {
      reference: "23.2.i)",
      subject: "Means of giving warning in case of fire",
      body: "The Responsible Person has a legal responsibility to manage the fire protection measures in a building, and failure to do so competently can lead to prosecution under the Regulatory Reform (Fire Safety) Order 2005. BS 5839 Part 1, the Code of Practice for design, installation, commissioning, and maintenance of fire alarm systems in non-domestic premises, has a focus on managing false alarms, which means doing so is necessary to maintain compliance.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s24-24-2-a",
    paragraph: {
      reference: "24.2.a)",
      subject: "Manual fire extinguishing appliances",
      body: [
        "The minimum quantity of extinguishers with an A rating should be calculated as follows:",
        "a) for any storey with a floor area less than or equal to 400 m2, there should be:",
        "1) at least two extinguishers with a class A rating; having",
        "2) a combined minimum total fire rating of 26A.",
        "b) for any storey with a floor area exceeding 400 m2, there should be:",
        "1) at least two (2) extinguishers with a class A rating; having",
        "2) a combined minimum total fire rating of 0.065 × floor area of the storey (in square metres)."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s24-24-2-b",
    paragraph: {
      reference: "24.2.b)",
      subject: "Manual fire extinguishing appliances",
      body: "Portable firefighting equipment up to 4kg in weight should be wall mounted by the use of suitable brackets so as to position the handle approximately 1.5m from the floor. Larger extinguishers should be mounted so as to position the handle approximately 1m from the floor. Alternative arrangements may be acceptable such as moulded plastic fire points, designed to securely hold extinguishers, positioned in prominent positions on the floor.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s24-24-2-c",
    paragraph: {
      reference: "24.2.c)",
      subject: "Manual fire extinguishing appliances",
      body: "Guidance on selection and positioning of fire extinguishers can be found in the BS 5306-8 Part 8. Extinguishers may be required for specific risks. Multipurpose extinguishers are available, and the ratings of each extinguisher should be examined.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s24-24-2-d",
    paragraph: {
      reference: "24.2.d)",
      subject: "Manual fire extinguishing appliances",
      body: [
        "Extinguishers should be unobstructed and available for immediate use at all times Extinguishers should not be located:",
        "1) where a potential fire might prevent access to them.",
        "2) over or close to heating appliances.",
        "3) in concealed positions behind doors, in cupboards or deep recesses.",
        "4) where they might cause obstruction to exit routes.",
        "5) in positions in rooms or corridors away from exit routes unless they are necessary to cover a particular hazard.",
        "6) where they might be damaged, e.g., by hotel-housekeeping trolleys or food-chain roll-cages."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s25-25",
    paragraph: {
      reference: "25",
      subject: "Relevant automatic fire extinguishing systems",
      body: [
        "life safety systems are put in place to save lives. From the initial detection of an emergency, such as a smoke alarm, to evacuation and response systems, such as fire exits, extinguishers and more, life safety systems exist to make our homes and workplaces safer for those who use it. Life safety systems are made up of elements that are designed to protect your building and its occupants during a fire or emergency situation.",
        "Verification must be sought that the system is maintained in accordance with the design specification and maintenance schedule"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s26-26-2-a",
    paragraph: {
      reference: "26.2.a)",
      subject: "Facilities and arrangements for firefighters",
      body: "A Requirement from Part B of Schedule 1 to the Building Regulations 2010. Access and facilities for the fire service B5.(1) of ADB states that, The building shall be designed and constructed so as to provide reasonable facilities to assist firefighters in the protection of life and Reasonable provision shall be made within the site of the building to enable fire appliances to gain access to the building.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s26-26-2-b",
    paragraph: {
      reference: "26.2.b)",
      subject: "Facilities and arrangements for firefighters",
      body: "The purpose of article 4 of the FSO is to create a clear demarcation between general fire precautions and other special precautions related to work processes. safety measures provided in a workplace in order to prevent or reduce the likelihood of fire arising directly from a work process (including the electrical safety, the storage and use of dangerous substances, goods, or materials) or to reduce its intensity, will remain within the remit of Health and Safety legislation. The client must take all reasonable steps to safeguard firefighters in a fire situation.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s26-26-2-c",
    paragraph: {
      reference: "26.2.c)",
      subject: "Facilities and arrangements for firefighters",
      body: [
        "i.) A fire hydrant should be located at the entrance to the site and if necessary, at 300 metre intervals. The hydrant should provide a minimum of 8 l/sec (480 l/min). If no piped water supply is available or where there is insufficient pressure or flow in the water main an alternative source must be provided and that no house on a development should be further than 90m from a hydrant, Each fire hydrant should be clearly indicated by a plate, affixed nearby in a conspicuous position, in accordance with BS 3251:1976.",
        "ii.) Private fire hydrants are located on private water mains that are not the responsibility of the local water company or the fire and rescue service. Private hydrants should be installed in accordance with the appropriate British standards and should be compatible with fire and rescue service equipment. Where private hydrants are installed they should be tested and maintained and be in good working order by the responsible person(s)."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s26-26-2-d",
    paragraph: {
      reference: "26.2.d)",
      subject: "Facilities and arrangements for firefighters",
      body: [
        "Buildings not fitted with fire mains",
        "There should be vehicle access for a pump appliance to small buildings (those of up to 2000m2 with a top storey up to 11m above ground level) to either:",
        "a. 15% of the perimeter; or",
        "b. within 45m (60m if provided with automatic fire suppression in line with Section 2) of every point on the projected plan area (or ‘footprint’, see Diagram 48 of ADB Wales ) of the building; whichever is the less onerous."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s26-26-2-e",
    paragraph: {
      reference: "26.2.e)",
      subject: "Facilities and arrangements for firefighters",
      body: [
        "BS 8629 is a “Code of practice for the design, installation, commissioning and maintenance of evacuation alert systems for use by fire and rescue services in buildings containing flats”. Evacuation alert systems are for use by the fire and rescue service only when the need arises to evacuate all or part of a building normally in stages, saving time in alerting occupants individually.",
        "The alarm system on an emergency evacuation alert system can be controlled by individual floors. This lets Fire & Rescue Services prioritise the zones closest to the fire and isolate the alarm alert so they can evacuate one floor at a time. The Evacuation Alert system does not incorporate any form of automatic detection."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s26-26-2-f",
    paragraph: {
      reference: "26.2.f)",
      subject: "Facilities and arrangements for firefighters",
      body: [
        "Wayfinding signage for the fire and rescue service should be provided in blocks of flats with a top storey more than 11m above ground level. It was agreed that there should be a more consistent approach to wayfinding signage for fire and rescue services in Approved Document B. (currently England only) To assist the fire service to identify each floor in a block of flats with a top storey more than 11m above ground level floor identification signs and flat indicator signs should be provided. The signs should be mounted between 1.7m and 2m above floor level and, as far as practicable, all the signs should be mounted at the same height.",
        "Assessment of Fire Safety Management"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s27-27-1",
    paragraph: {
      reference: "27.1",
      subject: "Procedures and arrangements",
      body: [
        "The responsible person must, subject to the exceptions in paragraphs (6) and (7), appoint",
        "one or more competent persons to assist them in undertaking the measure they need",
        "to take to comply with the requirements and prohibitions of this Order. A responsible",
        "person can nominate themselves."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s27-27-2-a",
    paragraph: {
      reference: "27.2.a)",
      subject: "Procedures and arrangements",
      body: "Insert relevant name",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s27-27-2-b",
    paragraph: {
      reference: "27.2.b)",
      subject: "Procedures and arrangements",
      body: "The fire safety arrangement policy document that details the planning, organisation, control, monitoring, and review of the preventive and protective measures must be prepared and made available so that a determination can be made as to whether it is suitable and sufficient.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s27-27-2-c",
    paragraph: {
      reference: "27.2.c)",
      subject: "Procedures and arrangements",
      body: [
        "As the responsible person, you must make arrangements for the event of a fire emergency namely, an evacuation plan. There are four types of fire evacuation strategies:",
        "Simultaneous evacuation.",
        "Vertical or horizontal phased evacuation.",
        "Staff alarm evacuation (silent alarm).",
        "Stay Put.",
        "The type of evacuation strategy depends entirely upon the size and nature of your premises and the people within it. Generally speaking, there will be aspects of fire evacuation that apply to almost all premises, such as having designated persons taking responsibility during the event of a fire (fire wardens)."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s27-27-2-d",
    paragraph: {
      reference: "27.2.d)",
      subject: "Procedures and arrangements",
      body: [
        "Fire safety and evacuation plans/Procedures Establish Roles and Responsibilities",
        "While assigning roles, there are many important considerations to acknowledge. You want to make sure your fire team is reliable, present, and able to react quickly in the face of an emergency. Additionally, make sure your organisation’s fire marshals aren’t weighted towards one department, but you want to make sure your team is spread out across all departments and locations.",
        "Your plan must show how you have:",
        "a clear passageway to all escape routes",
        "clearly marked escape routes that are as short and direct as possible",
        "enough exits and routes for all people to escape",
        "emergency doors that open easily",
        "emergency lighting where needed",
        "training for all employees to know and use the escape routes",
        "a safe meeting point for staff",
        "People with mobility needs",
        "You should also make special arrangements for people with mobility needs, for example make sure there are people to help wheelchair users get downstairs if there’s a fire."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s27-27-2-e",
    paragraph: {
      reference: "27.2.e)",
      subject: "Procedures and arrangements",
      body: [
        "Owners’, occupiers and managers have a legal duty to make sure that all people who use or visit their buildings can reach a “Place of Total Safety” in the event of a fire safety emergency. A Personal Emergency Evacuation Plan, or PEEP, is a bespoke “escape plan” for individuals who may have difficulties evacuating a building to a Total Place of Safety without support or assistance from others.",
        "PEEPs are particularly relevant for some residents (or indeed staff) with mobility and/or sensory impairments (visual/hearing). Additionally, depending on the nature/severity of the impairment, in some limited circumstances it might be relevant to create a PEEP for persons with other disability types. Each PEEP must be specific to the individual, their needs, and the buildings which they use."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s27-27-2-f",
    paragraph: {
      reference: "27.2.f)",
      subject: "Procedures and arrangements",
      body: [
        "You should prepare all the necessary contacts with external emergency services and make them familiar with your fire action plan. A senior person should be nominated to meet the fire and rescue service when they arrived to provide them with any information they require. Informing them of the location and type of fire (combustible materials, electrical, flammable liquid etc) location of all occupants.",
        "They should have an intimate knowledge of the premises and be in contact with the person conducting the roll call at the assembly point."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s27-27-2-g",
    paragraph: {
      reference: "27.2.g)",
      subject: "Procedures and arrangements",
      body: [
        "A fire strategy document is particularly useful for setting out the design basis of the premises in respect of fire.",
        "A fire strategy will show compliance with Building Regulations; mainly means of warning and escape, internal fire spread (linings), internal fire spread (structure), external fire spread and escape, access, and facilities for the fire service.",
        "A fire strategy may be carried out for existing buildings which will allow the landlord, fire risk assessor and other interested parties to view the manner in which a building is constructed, the assumptions which have been made, the precautions and how these complement rather than work against one another."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s27-27-2-h",
    paragraph: {
      reference: "27.2.h)",
      subject: "Procedures and arrangements",
      body: "In the event of a fire or other emergency, a companion, carer, or assistant may be allocated to assist Individuals who have a permanent or temporary disability/impairment/disorder which may affect their ability to recognise that an emergency is taking place or to evacuate a building unaided. This is a voluntary provision and may not always be feasible one possibility might be a “buddy system” whereby designated people nearby will assist",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s28-28-2-a",
    paragraph: {
      reference: "28.2.a)",
      subject: "Training and drills",
      body: "Legislation requires that all employers provide appropriate health & safety training to all staff. This includes providing fire safety training instruction as part of the induction program for all new members of staff. https://fita.org.uk/",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s28-28-2-b",
    paragraph: {
      reference: "28.2.b)",
      subject: "Training and drills",
      body: "Fire safety training should be conducted with your staff every 12 months, by providing annual training, you can effectively refresh the knowledge of your team on fire safety. That way, you can be assured that they will act appropriately in the event of a fire breaking out at work. https://fita.org.uk/",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s28-28-2-c",
    paragraph: {
      reference: "28.2.c)",
      subject: "Training and drills",
      body: [
        "To ensure that fire safety regulations and safety protocols are followed in the event of a fire, as a property owner or building manager you should have a designated fire marshal or warden for your building. A fire marshal is primarily responsible for the identification of potential fire hazards in a building.",
        "28.2.c.i) The fire warden should work together with the employer to ensure that fire safety measures and evacuation procedures are in place and effective. They will have a greater understanding of fire, familiar with fire hazards and fire safety arrangements, and what your emergency evacuation procedures entail."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s28-28-2-d",
    paragraph: {
      reference: "28.2.d)",
      subject: "Training and drills",
      body: "The Regulatory Reform (Fire Safety) Order stipulates that the individual tasked with the responsibilities of fire safety in non-domestic and commercial premises should be the manager, owners, or the occupants. The appointed “responsible person,” should be tasked with planning for emergencies and communicate relevant information to residents and staff regarding fire safety and ensure that fire drills are carried out periodically.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s28-28-2-e",
    paragraph: {
      reference: "28.2.e)",
      subject: "Training and drills",
      body: [
        "A fire safety logbook and maintenance record should remain on the premises at all times. The register will assist you in proving compliance with your legal responsibilities in relation to fire safety and should be completed following the inspection, test, and maintenance of any of the items required by the legislation.",
        "The fire safety logbook should be available for inspection by any Fire Officer who inspects your premises under the Regulatory Reform (Fire Safety) Order 2005. It should also be available to relevant employees, or any service engineer as required."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s28-28-2-f",
    paragraph: {
      reference: "28.2.f)",
      subject: "Training and drills",
      body: "All staff and employers of other people working in your premises, such as contractors must be given comprehensible and relevant information and appropriate instructions about how to prevent fires and what they should do if there is a fire.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s28-28-2g",
    paragraph: {
      reference: "28.2g.)",
      subject: "Training and drills",
      body: "Staff have a vital role in communicating the evacuation plan to disabled visitors, and to fulfil this role effectively they will be required to undergo disability escape etiquette training.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s29-29-2-a",
    paragraph: {
      reference: "29.2.a)",
      subject: "Testing and maintenance",
      body: "The existing fire alarm system should be tested in accordance with BS5839 Part  1 or 6 to ensure satisfactory operation and audibility of the system. It is recommended that the results of the test are recorded in a suitable logbook.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s29-29-2-b",
    paragraph: {
      reference: "29.2.b)",
      subject: "Testing and maintenance",
      body: [
        "Routine inspections and tests of the emergency lighting system should be undertaken based on BS 5266: Part 8 which, among other things, indicates that tests should, wherever possible, be undertaken at time of minimum risk, and associated with inspections, at frequencies as follows:",
        "Daily check.",
        "Monthly test.",
        "Subsequent Annual Test.",
        "The date of all such tests and any resulting maintenance of the emergency lighting system should be recorded in a logbook with the exception of the daily test, where there are no faults or repairs found."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s29-29-2c",
    paragraph: {
      reference: "29.2c)",
      subject: "Testing and maintenance",
      body: [
        "All portable fire extinguishers should be periodically inspected, maintained, and tested in accordance with a relevant standard. As a minimum extinguishers should receive a basic service by a competent person every 12 months.",
        "For a relevant standard refer to BS5306 Pt 3 Fire extinguishing installations and equipment on premises code of practice for inspection and maintenance of portable fire extinguishers. Compliance with this or an equivalent standard will normally satisfy the requirement."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s29-29-2d",
    paragraph: {
      reference: "29.2d)",
      subject: "Testing and maintenance",
      body: "The Responsible Person must ensure that the premises and any facilities, equipment and devices provided in respect of the premises for use by or protection of fire-fighters are subject to a suitable system of maintenance and are maintained in an efficient state in efficient working order and in good repair.",
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s29-29-2e",
    paragraph: {
      reference: "29.2e)",
      subject: "Testing and maintenance",
      body: [
        "Recommendations as contained in BS 9999 that a suitable programme of maintenance for the lift should be agreed between the responsible person and the lift maintenance contractor. Examination of lifts in service and recommends that the responsible person should ensure that all firefighting and/or evacuation features and functions of the lift are thoroughly examined periodically.",
        "The responsible person should ensure that equipment not part of the lift (such as secondary supplies, supply changeover equipment, any pit drainage pumps, firefighting or evacuation communications systems, automatic recall devices, external indicators, and any labelling) is subject to a suitable programme of maintenance."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s29-29-2-f",
    paragraph: {
      reference: "29.2.f)",
      subject: "Testing and maintenance",
      body: [
        "The testing of fire doors is a crucial routine and could save lives. Fire safety checks need to be completed at least every 6 months. This testing, servicing and repairs should be done by professionals. They have the skills, knowledge, and experience to ensure your fire doors are working as they should. However, there are some things you can check every couple of months to ensure your fire doors are working well.",
        "They should be checked bi-annually for obvious signs of damage to.",
        "self-closing devices,",
        "intumescent strips,",
        "the doors themselves or the frames in which they sit,",
        "poorly fitting doors, or any changes to the door locks or door furniture which may compromise the ability of the door to resist fire."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s30-30-2a-b-c",
    paragraph: {
      reference: "30.2a.),b.),c.)",
      subject: "Records",
      body: [
        "A fire safety logbook and maintenance record should remain on the premises at all times. The register will assist you in proving compliance with your legal responsibilities in relation to fire safety and should be completed following the inspection, test, and maintenance of any of the items required by the legislation",
        "The fire safety logbook should record regular checks and record findings on:",
        "All escape routes are clear, and the floor is in a good state",
        "All fire escapes can be opened easily",
        "You record any faults in systems and equipment",
        "All fire alarm systems are working",
        "The emergency lighting is working",
        "Fire doors close correctly and in good working order",
        "Fire exit signs are in the right place",
        "Training and Fire drill log"
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s31-31",
    paragraph: {
      reference: "31",
      subject: "Premises information box",
      body: [
        "The Fire Safety (England) Regulations 2022 will make it a legal requirement from 23 January 2023 for existing high-rise residential buildings in England to have a secure information box installed on the premises.",
        "The regulations will require the responsible person to install a suitably secure information box in or on their high-rise building. They will also be required to provide in the box:",
        "Their UK contact details",
        "The UK contact details of any other person who has the facilities to and is permitted to access the building as the responsible person considers appropriate",
        "Copies of the building’s floor plans – which identify specified key fire-fighting equipment",
        "A single page block plan - which identifies specified key fire-fighting equipment",
        "Access should be given to the fire and rescue service. Boxes should be maintained, and their contents kept up to date in line with the duties imposed by the regulations and the Fire Safety Order."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s32-32-2-a",
    paragraph: {
      reference: "32.2.a)",
      subject: "Residents engagement strategy",
      body: [
        "Residents can expect to be informed about the measures being taken to make their building safe. The new fire safety Bill empowers residents of higher-risk buildings to raise safety concerns and to know that these will be taken seriously by those responsible for managing the safety of their building.",
        "The new requirements go further to enhance the provision of information and help residents be informed and involved. It is also important that you record your name and a UK address in the fire risk assessment to make it easier for enforcement authorities to identify you.",
        "You must provide residents with the following information:",
        "any risks to residents identified in the fire risk assessment",
        "the fire safety measures provided for the safety of any or all occupants (such as the means of escape, the measures to restrict the spread of fire and what people should do in the event of a fire)",
        "your name and the UK address at which you, or someone acting on your behalf, will accept notices or other documents",
        "the identity of any person appointed to assist with making or reviewing the fire risk assessment",
        "the identity of any competent person nominated by the Responsible Person to implement firefighting measures",
        "any risks to relevant persons throughout the building that have been identified by other Responsible Persons in the building",
        "The Bill also recognises that residents have an important role to play in keeping their building safe and it places a responsibility on residents to make sure their actions do not negatively impact on the safety of others."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
  {
    id: "sp-bs9792-s32-32-2b",
    paragraph: {
      reference: "32.2b)",
      subject: "Residents engagement strategy",
      body: [
        "It is recommended that a Retrospective Fire Strategy be carried out for the existing buildings which will allow the landlord, fire risk assessor and other interested parties to view the manner in which a building is constructed, the assumptions which have been made, the precautions and how this complement rather than work against one another.",
        "A fire strategy document is particularly useful for setting out the design basis of the premises in respect of fire. It will also show compliance with Building Regulations, mainly means of warning and escape, internal fire spread (linings), internal fire spread (structure), external fire spread and escape, access, and facilities for the fire service.",
        "The Accountable Person must ensure the effective assessment and management of their building’s safety and will be required to provide certain information to residents about their building. The Principal Accountable Person must also promote the participation of residents in relevant decision-making about their building’s safety."
      ].join('\n'),
      updatedAt: BS9792_PARAGRAPHS_RELEASED_AT,
    },
  },
];
