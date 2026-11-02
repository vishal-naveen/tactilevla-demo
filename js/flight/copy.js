// Flight copy, round 12 (data only). What the project is, and what every stop shows and why it matters, in plain English.
// Every number and claim is traced to the repo in ../tactilevla-redesign/render/copy_sources.md. Rules: no invented numbers,
// the 3D is a kinematic reconstruction, the 18/20 and 16/20 are 20 trials per policy across the whole grid (B2 included),
// touch is future work, no URDF effort/velocity limits, no em dashes, no middle dots.
// `stops[i].stop` = the index into nav.js STOPS; `scene` = the SCENES id that stop sits in (path.js), for a safety check.

const intro = {
  kicker: 'TACTILEVLA-EDGE',
  headline: 'A robot arm that learns by watching.',
  // owner 2026-11-02: "the start is just a little crowded": the opening keeps three sentences; the servo paragraph
  // moved to 02 (the arm pulled apart), the reconstruction note is the top-left chip, results come at 09
  body: 'An open-source SO-101 arm, under $300, learned one job from 160 human demonstrations: pick up a foam noodle and drop it in a cup. ' +
    'Then it was tested across the table, including B2, a cell it never practised. ' +
    'In 20 trials each, ACT succeeded 18 times and SmolVLA 16.',
  look: '',
  facts: ['160 DEMONSTRATIONS', '2 POLICIES', 'UNDER $300'],
}

// round 13 CAMERA: 16 stops (was 20). Merged stops keep every word: the first stop's kicker / headline / body lead, each
// merged stop's headline + body follow as `more` (hud.js prints them under the body), facts are the union in order.
const stops = [  { stop: 0, scene: 'S1', kicker: '01 / THE PROJECT', headline: 'A robot arm that learns by watching.',
    body: 'This is an SO-101, an open-source arm built for under $300. It was taught one job from 160 human demonstrations, then tested on a spot of the table it had never seen.',
    facts: ['SO-101 FOLLOWER ARM', 'UNDER $300', '160 DEMONSTRATIONS'] },
  { stop: 1, scene: 'S2', kicker: '02 / THE SETUP', headline: 'The setup: a sub-$300 arm.',
    body: 'Here the arm is pulled apart: 3D-printed links, one servo per joint. A person moves a leader arm by hand and this follower copies it. That is how every demonstration was recorded.',
    more: [{ headline: 'Six joints, each one servo.', body: 'Every joint, from the base to these gripper jaws, is one Feetech STS3215 servo. The trained policy drives it by setting a target for each joint, in a control loop set to 30 times a second.' }],
    facts: ['LINKS 3D-PRINTED PLA', '≈1/100 THE COST OF RESEARCH ARMS', '6 FEETECH STS3215 SERVOS', 'CONTROL LOOP SET TO 30 HZ'] },
  { stop: 2, scene: 'S2', kicker: '02 / ONE SERVO', headline: 'Each joint is one STS3215 servo.',
    body: 'The elbow servo, lifted out of the arm. Its labels are read from the arm’s URDF file at load. The same servo also reports the load on it, the signal the planned touch work will read.',
    facts: ['ELBOW FLEX, REVOLUTE JOINT', 'SOURCE: SO101_NEW_CALIB.URDF'] },
  { stop: 3, scene: 'S3', kicker: '03 / THE TASK', headline: 'One job: the noodle goes in the cup.',
    body: 'Pick up a short piece of foam pool noodle and drop it in the yellow cup. A run counts only if the noodle ends up inside. The foam is soft and rolls, so no two starts are quite the same.',
    more: [{ headline: 'Eight cells teach. B2 stays empty.', body: 'The noodle starts on a 3×3 grid of table spots, A1 to C3. Eight cells were used for teaching. The centre, B2, was left out on purpose: it has taught cells on all four sides.' }],
    facts: ['SUCCESS = NOODLE IN THE CUP', 'OBJECT: SOFT FOAM, ROLLS', 'GRID 3×3, A1 TO C3', '8 CELLS TAUGHT', 'B2 HELD OUT'] },
  { stop: 4, scene: 'S4', kicker: '04 / HOW IT LEARNED', headline: '160 demonstrations, one hand at a time.',
    body: 'Each one is a person guiding the leader arm through the job while two cameras record, then resetting the noodle by hand. Four rounds round the grid. The count is real; noodle positions are illustrative.',
    facts: ['160 EPISODES', '67,693 FRAMES AT 30 FPS', '20 PER CELL, 0 IN B2'] },
  { stop: 5, scene: 'S4', kicker: '04 / THE GAP', headline: '20 per cell. None in B2.',
    body: 'Within each cell the noodle was turned through ±90° in 10° steps, so no cell is one memorized pose. B2, in the middle, never got a single demonstration.',
    facts: ['NOODLE ±90° IN 10° STEPS', 'B2: 0 OF 160 EPISODES'] },
  { stop: 6, scene: 'S5', kicker: '05 / WHAT IT SEES', headline: 'Two cameras. At the grasp, one goes blind.',
    body: 'The policy sees through an overhead camera and this wrist camera, plus the arm’s six joint positions. As the jaws close, the gripper hides the noodle from overhead; the wrist view keeps the grasp visible.',
    more: [{ headline: 'Two images and six joint angles.', body: 'The light cones show what each camera covers; the small frames are real images from training episode 0. Those two views plus six joint positions are the whole input. No touch signal was used.' }],
    facts: ['WRIST 640×480', 'OVERHEAD 800×600', 'BOTH 30 FPS', 'IN: 2 IMAGES + 6 JOINT POSITIONS', 'OUT: 6 JOINT TARGETS'] },
  { stop: 7, scene: 'S6', kicker: '06 / TWO POLICIES', headline: 'Two policies, the same 160 episodes.',
    body: 'ACT is a compact model with a ResNet18 vision backbone. SmolVLA-450M builds on a pretrained vision-language model. Each predicts a chunk of future moves at once; the trail illustrates that, it is not policy output.',
    facts: ['ACT ~52M, 100 ACTIONS PER CHUNK', 'SMOLVLA ~450M, 50 PER CHUNK', 'TRAINED ON ONE RTX 3060'] },
  { stop: 8, scene: 'S7', kicker: '07 / THE TEST', headline: 'It never saw B2.',
    body: 'Now the noodle sits in B2, the cell missing from all 160 demonstrations. Replaying a remembered move would not fit here, so doing the job shows the policy learned the task itself.',
    facts: ['B2: 0 OF 160 EPISODES', 'B2 LIGHT IS STAGED'] },
  { stop: 9, scene: 'S7', kicker: '07 / THE GRASP', headline: 'The grasp, in a cell never practised.',
    body: 'Both policies were tried in B2 several times, and every attempt succeeded. No B2 success rate is claimed: there is no per-trial log, only the operator’s record of the session.',
    more: [{ headline: 'It picked the noodle up anyway.', body: 'From only 160 demonstrations, both models carried the job into a part of the table they were never shown. The motion here is a reconstruction; the real B2 runs come next.' }],
    facts: ['ACT IN B2: SUCCESS', 'SMOLVLA-450M IN B2: SUCCESS', 'RECONSTRUCTION, NOT RECORDED MOTION'] },
  { stop: 10, scene: 'S8', kicker: '08 / THE PROOF', headline: 'Four real runs, all successful.',
    body: 'These are real videos, filmed end to end with the cell called out before each run: two in held-out B2, two in trained cells. They are demonstrations, not the scored trials.',
    facts: ['ACT: B2 AND A2', 'SMOLVLA-450M: B2 AND C3', '4 OF 4 SUCCEEDED'] },
  { stop: 11, scene: 'S9', kicker: '09 / RESULTS', headline: '18 of 20. 16 of 20.',
    body: 'Each policy ran 20 autonomous trials on the real arm, spread across the whole grid, B2 included, and scored by hand. A trial counts only if the noodle ends up in the cup.',
    facts: ['ACT 18/20, 95% CI 68 TO 99%', 'SMOLVLA-450M 16/20, 95% CI 56 TO 94%'] },
  { stop: 12, scene: 'S10', kicker: '10 / LIMITS', headline: 'What this doesn’t show.',
    body: 'It is not a ranking: the two intervals overlap, and telling 90% from 80% apart would take about a hundred trials each. It is one task, one object, one lighting setup, and no touch.',
    facts: ['VISION ONLY, NO TACTILE DATA', 'NO PER-TRIAL LOG', 'NOT TESTED OUTSIDE THE GRID'] },
  { stop: 13, scene: 'S11', kicker: '11 / WHAT’S NEXT', headline: 'What’s next: touch. Not built yet.',
    body: 'Every STS3215 servo reports the load on it, so touch could come with no added hardware. In a bench test, pressing by hand moved those readings. The glow here is drawn from them, not live sensing.',
    facts: ['BENCH PEAKS 48 TO 152, RAW UNITS', 'SHOULDER LIFT HIGHEST, 152', 'PHASE 3, NOT BUILT YET'] },
  { stop: 14, scene: 'S12', kicker: '12 / SANDBOX', headline: 'Try it yourself: pick a cell.',
    body: 'Choose any cell, B2 included, or click the table, and the 3D arm does the job there. This is a kinematic simulation from the arm’s URDF, not the trained policy.',
    facts: ['IK SIMULATION, NOT POLICY'] },
  { stop: 15, scene: 'S13', kicker: '13 / WHAT I BUILT', headline: 'What I built.',
    body: 'The arm setup with two cameras, 160 demonstrations with one cell held out on purpose, two trained policies, 20 scored trials each on the real arm, and the scripts and tests behind them.',
    facts: ['BUILT ON SO-101, SMOLVLA, LEROBOT', 'CODE APACHE-2.0', 'HARDWARE CERN-OHL-P V2'] },
]

export default { intro, stops }
