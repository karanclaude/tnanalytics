const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 4003;

const SESSIONS_FILE = path.join(__dirname, 'data', 'sessions.json');
const EVENTS_FILE   = path.join(__dirname, 'data', 'events.jsonl');

// ── STORAGE SETUP ──
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}
if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '{}');
if (!fs.existsSync(EVENTS_FILE))   fs.writeFileSync(EVENTS_FILE, '');

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ── IN-MEMORY CACHE (sessions) ──
// Loaded once at startup, written through on every update
let sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));

function saveSessions() {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 0));
}

function appendEvent(ev) {
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(ev) + '\n');
}

function readEvents() {
  const raw = fs.readFileSync(EVENTS_FILE, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ── SCREEN ORDER ──
const SCREEN_ORDER = [
  'screen-entry', 'screen-goal', 'screen-social',
  'screen-quiz', 'screen-plan', 'screen-loader',
  'screen-email', 'screen-pathway', 'screen-soft-pitch', 'screen-selling'
];
function screenRank(screen) {
  const base = (screen || '').replace(/-q\d+$/, '');
  const r = SCREEN_ORDER.indexOf(base);
  return r === -1 ? 0 : r;
}

// ── TRACK ENDPOINT ──
app.post('/api/track', (req, res) => {
  try {
    const {
      sessionId, eventType, screen, questionId, questionIndex,
      answerIndex, answerText, signalType, metadata,
      name, phone, goal, level, answers, signalsSeen
    } = req.body;

    if (!sessionId || !eventType) return res.status(400).json({ error: 'Missing required fields' });

    const ts = new Date().toISOString();

    // Upsert session
    if (!sessions[sessionId]) {
      sessions[sessionId] = {
        id: sessionId,
        started_at: ts,
        last_seen: ts,
        referrer: req.headers['referer'] || '',
        user_agent: req.headers['user-agent'] || '',
        name: null, phone: null, goal: null, level: null,
        answers: null, furthest_screen: null,
        quiz_furthest_step: 0,
        reached_plan: 0, reached_email: 0, reached_pathway: 0,
        reached_soft_pitch: 0, reached_selling: 0,
        lead_captured: 0, cta_clicked: 0, signals_seen: null
      };
    }

    const s = sessions[sessionId];
    s.last_seen = ts;
    if (name) s.name = name;
    if (phone) s.phone = phone;
    if (goal) s.goal = goal;
    if (level) s.level = level;
    if (answers) s.answers = answers;
    if (signalsSeen) s.signals_seen = signalsSeen;

    const sr = screenRank(screen);
    if (!s.furthest_screen || screenRank(s.furthest_screen) < sr) s.furthest_screen = screen;

    const qStep = questionIndex !== undefined ? questionIndex : 0;
    if (qStep > s.quiz_furthest_step) s.quiz_furthest_step = qStep;

    if (sr >= screenRank('screen-plan'))       s.reached_plan = 1;
    if (sr >= screenRank('screen-email'))      s.reached_email = 1;
    if (sr >= screenRank('screen-pathway'))    s.reached_pathway = 1;
    if (sr >= screenRank('screen-soft-pitch')) s.reached_soft_pitch = 1;
    if (sr >= screenRank('screen-selling'))    s.reached_selling = 1;
    if (eventType === 'lead_capture')          s.lead_captured = 1;
    if (eventType === 'cta_click')             s.cta_clicked = 1;

    saveSessions();

    appendEvent({
      sessionId, eventType, screen: screen || null,
      questionId: questionId || null,
      questionIndex: questionIndex !== undefined ? questionIndex : null,
      answerIndex: answerIndex !== undefined ? answerIndex : null,
      answerText: answerText || null,
      signalType: signalType || null,
      metadata: metadata || null,
      ts
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Track error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── HELPERS ──
function filterByDate(list, from, to, dateKey = 'started_at') {
  return list.filter(s => {
    const d = (s[dateKey] || '').slice(0, 10);
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    return true;
  });
}

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

// ── OVERVIEW ──
app.get('/api/analytics/overview', (req, res) => {
  const { from, to } = req.query;
  const all = filterByDate(Object.values(sessions), from, to);

  const total     = all.length;
  const leads     = all.filter(s => s.lead_captured).length;
  const selling   = all.filter(s => s.reached_selling).length;
  const cta       = all.filter(s => s.cta_clicked).length;
  const plan      = all.filter(s => s.reached_plan).length;
  const email     = all.filter(s => s.reached_email).length;
  const avgStep   = avg(all.filter(s => s.quiz_furthest_step > 0).map(s => s.quiz_furthest_step));

  // Daily trend
  const byDay = {};
  all.forEach(s => {
    const day = s.started_at.slice(0, 10);
    if (!byDay[day]) byDay[day] = { day, sessions: 0, leads: 0, selling: 0 };
    byDay[day].sessions++;
    if (s.lead_captured) byDay[day].leads++;
    if (s.reached_selling) byDay[day].selling++;
  });
  const trend = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)).slice(-30);

  res.json({
    total, leads, selling, ctaClicks: cta, reachedPlan: plan, reachedEmail: email,
    leadRate: total ? ((leads / total) * 100).toFixed(1) : 0,
    sellRate: total ? ((selling / total) * 100).toFixed(1) : 0,
    ctaRate: leads ? ((cta / leads) * 100).toFixed(1) : 0,
    avgQuizStep: avgStep.toFixed(1),
    trend
  });
});

// ── FUNNEL ──
app.get('/api/analytics/funnel', (req, res) => {
  const { from, to } = req.query;
  const sessAll = filterByDate(Object.values(sessions), from, to);
  const sessIds = new Set(sessAll.map(s => s.id));

  const events = filterByDate(readEvents(), from, to, 'ts').filter(e => sessIds.has(e.sessionId));

  // Screen view counts
  const screenMap = {};
  events.filter(e => e.eventType === 'screen_view').forEach(e => {
    const s = e.screen || '';
    screenMap[s] = (screenMap[s] || 0) + 1; // approximate (not unique)
  });

  // Unique session counts per screen (more accurate)
  const screenSessions = {};
  const seenScreenSession = new Set();
  events.filter(e => e.eventType === 'screen_view').forEach(e => {
    const key = `${e.sessionId}::${e.screen}`;
    if (!seenScreenSession.has(key)) {
      seenScreenSession.add(key);
      const s = e.screen || '';
      screenSessions[s] = (screenSessions[s] || 0) + 1;
    }
  });

  // Quiz step view counts (unique per session)
  const quizStepMap = {};
  const seenQStep = new Set();
  events.filter(e => e.eventType === 'question_view').forEach(e => {
    const key = `${e.sessionId}::${e.questionIndex}`;
    if (!seenQStep.has(key)) {
      seenQStep.add(key);
      const qi = e.questionIndex;
      if (qi !== null) quizStepMap[qi] = (quizStepMap[qi] || 0) + 1;
    }
  });
  const quizSteps = Object.entries(quizStepMap)
    .map(([qi, n]) => ({ question_index: parseInt(qi), n }))
    .sort((a, b) => a.question_index - b.question_index);

  // Signal stats
  const signalViews = {};
  const signalConts = {};
  const seenSigView = new Set();
  const seenSigCont = new Set();
  events.filter(e => e.eventType === 'signal_view').forEach(e => {
    const key = `${e.sessionId}::${e.signalType}`;
    if (!seenSigView.has(key)) { seenSigView.add(key); signalViews[e.signalType] = (signalViews[e.signalType] || 0) + 1; }
  });
  events.filter(e => e.eventType === 'signal_continue').forEach(e => {
    const key = `${e.sessionId}::${e.signalType}`;
    if (!seenSigCont.has(key)) { seenSigCont.add(key); signalConts[e.signalType] = (signalConts[e.signalType] || 0) + 1; }
  });
  const allSignalTypes = [...new Set([...Object.keys(signalViews), ...Object.keys(signalConts)])];
  const signalStats = allSignalTypes.map(t => ({ signal_type: t, views: signalViews[t] || 0, continues: signalConts[t] || 0 }));

  const sm = screenSessions;
  res.json({
    total: sessAll.length,
    screenMap: sm,
    quizSteps,
    signalStats,
    funnelSteps: [
      { name: 'Started Quiz',         screen: 'screen-entry',      count: sm['screen-entry']      || 0 },
      { name: 'Selected Goal',        screen: 'screen-goal',       count: sm['screen-goal']       || 0 },
      { name: 'Passed Social Proof',  screen: 'screen-social',     count: sm['screen-social']     || 0 },
      { name: 'Reached Quiz',         screen: 'screen-quiz',       count: sm['screen-quiz']       || 0 },
      { name: 'Reached Plan',         screen: 'screen-plan',       count: sm['screen-plan']       || 0 },
      { name: 'Reached Email',        screen: 'screen-email',      count: sm['screen-email']      || 0 },
      { name: 'Reached Pathway',      screen: 'screen-pathway',    count: sm['screen-pathway']    || 0 },
      { name: 'Reached Soft Pitch',   screen: 'screen-soft-pitch', count: sm['screen-soft-pitch'] || 0 },
      { name: 'Reached Selling',      screen: 'screen-selling',    count: sm['screen-selling']    || 0 },
    ]
  });
});

// ── ANSWERS ──
app.get('/api/analytics/answers', (req, res) => {
  const { from, to } = req.query;
  const sessAll = filterByDate(Object.values(sessions), from, to);
  const sessIds = new Set(sessAll.map(s => s.id));

  const events = filterByDate(readEvents(), from, to, 'ts')
    .filter(e => e.eventType === 'question_answer' && sessIds.has(e.sessionId));

  // Group: questionId → answerIndex → {text, count}
  const grouped = {};
  const seenAnswer = new Set();
  events.forEach(e => {
    const key = `${e.sessionId}::${e.questionId}::${e.answerIndex}`;
    if (seenAnswer.has(key)) return;
    seenAnswer.add(key);

    const qKey = e.questionId || `q${e.questionIndex}`;
    if (!grouped[qKey]) grouped[qKey] = { questionId: qKey, questionIndex: e.questionIndex || 0, answers: {} };
    const aKey = e.answerIndex;
    if (!grouped[qKey].answers[aKey]) grouped[qKey].answers[aKey] = { index: aKey, text: e.answerText || '', count: 0 };
    grouped[qKey].answers[aKey].count++;
  });

  const questions = Object.values(grouped).map(q => ({
    ...q,
    answers: Object.values(q.answers).sort((a, b) => a.index - b.index)
  })).sort((a, b) => a.questionIndex - b.questionIndex);

  res.json({ questions });
});

// ── LEADS ──
app.get('/api/analytics/leads', (req, res) => {
  const {
    from, to, search, goal, lead_captured, cta_clicked,
    reached_selling, income, sort = 'started_at', order = 'desc',
    page = 1, limit = 50
  } = req.query;

  let list = filterByDate(Object.values(sessions), from, to);

  if (search) {
    const q = search.toLowerCase();
    list = list.filter(s => (s.name || '').toLowerCase().includes(q) || (s.phone || '').includes(q));
  }
  if (goal) list = list.filter(s => s.goal === goal);
  if (lead_captured !== undefined && lead_captured !== '') list = list.filter(s => s.lead_captured === parseInt(lead_captured));
  if (cta_clicked !== undefined && cta_clicked !== '')  list = list.filter(s => s.cta_clicked === parseInt(cta_clicked));
  if (reached_selling !== undefined && reached_selling !== '') list = list.filter(s => s.reached_selling === parseInt(reached_selling));
  if (income !== '' && income !== undefined) {
    list = list.filter(s => s.answers && s.answers.income_goal === parseInt(income));
  }

  // Sort
  const validSorts = ['started_at', 'name', 'lead_captured', 'cta_clicked', 'reached_selling', 'quiz_furthest_step'];
  const sortCol = validSorts.includes(sort) ? sort : 'started_at';
  list.sort((a, b) => {
    const va = a[sortCol] || 0;
    const vb = b[sortCol] || 0;
    if (order === 'asc') return va > vb ? 1 : va < vb ? -1 : 0;
    return va < vb ? 1 : va > vb ? -1 : 0;
  });

  const total = list.length;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const paged = list.slice(offset, offset + parseInt(limit));

  res.json({ total, page: parseInt(page), limit: parseInt(limit), leads: paged });
});

// ── EXPORT CSV ──
app.get('/api/analytics/export', (req, res) => {
  const all = Object.values(sessions);
  const INCOME  = ['₹10K–₹20K', '₹20K–₹50K', '₹50K–₹1L', '₹1L+'];
  const INVEST  = ['Free only', 'Under ₹10K', '₹25K–₹50K', '₹2–5L'];
  const GOALS   = ['Earn extra income', 'Start full bakery', 'Bake for family', 'Get certified'];
  const LEVEL   = ['Complete beginner', 'Bake occasionally', 'Bake regularly', 'Sometimes sell'];
  const CHAL    = ['Consistent results', 'Eggless recipes', 'Pricing', 'Marketing'];
  const STYLE   = ['Watch & follow', 'Live feedback', 'Own pace', 'Intensive'];
  const KITCHEN = ['Basic stove', 'Standard OTG', 'Well-equipped', 'Semi-pro'];
  const CUST    = ['Family & friends', 'Local community', 'Corporate', 'Online'];
  const START   = ['Right now', 'Next 2 weeks', 'Next month', 'Still exploring'];

  const lbl = (map, idx) => idx !== undefined && idx !== null && map[idx] !== undefined ? map[idx] : '';

  const headers = ['Session ID','Date','Name','Phone','Goal','Baking Level','Main Goal','Income Goal','Investment','Current Level','Biggest Challenge','Learning Style','Kitchen','Customers','Start When','Furthest Screen','Quiz Steps','Lead Captured','CTA Clicked','Reached Selling'];

  const rows = all.map(s => {
    const a = s.answers || {};
    return [
      s.id, s.started_at?.slice(0,10), s.name||'', s.phone||'',
      s.goal||'', s.level||'',
      lbl(GOALS, a.main_goal), lbl(INCOME, a.income_goal), lbl(INVEST, a.investment_willingness),
      lbl(LEVEL, a.current_level), lbl(CHAL, a.biggest_challenge),
      lbl(STYLE, a.learning_style), lbl(KITCHEN, a.kitchen), lbl(CUST, a.customer_base), lbl(START, a.start_when),
      s.furthest_screen||'', s.quiz_furthest_step,
      s.lead_captured ? 'Yes' : 'No',
      s.cta_clicked ? 'Yes' : 'No',
      s.reached_selling ? 'Yes' : 'No'
    ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="tn-leads.csv"');
  res.send([headers.join(','), ...rows].join('\n'));
});

// ── LP (LANDING PAGE) DATA STORAGE ──
const LP_SESSIONS_FILE = path.join(__dirname, 'data', 'lp-sessions.json');
const LP_EVENTS_FILE   = path.join(__dirname, 'data', 'lp-events.jsonl');
if (!fs.existsSync(LP_SESSIONS_FILE)) fs.writeFileSync(LP_SESSIONS_FILE, '{}');
if (!fs.existsSync(LP_EVENTS_FILE))   fs.writeFileSync(LP_EVENTS_FILE, '');
let lpSessions = JSON.parse(fs.readFileSync(LP_SESSIONS_FILE, 'utf8'));
function saveLPSessions() { fs.writeFileSync(LP_SESSIONS_FILE, JSON.stringify(lpSessions, null, 0)); }
function appendLPEvent(ev) { fs.appendFileSync(LP_EVENTS_FILE, JSON.stringify(ev) + '\n'); }
function readLPEvents() {
  const raw = fs.readFileSync(LP_EVENTS_FILE, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ── LP TRACK ──
app.post('/api/lp/track', (req, res) => {
  try {
    const { eventType, source, sessionId, name, phone, email, score, qualified, answers, utms, fbclid, fbc, fbp, stepIndex } = req.body;
    if (!eventType || !source) return res.status(400).json({ error: 'Missing required fields' });
    const ts = new Date().toISOString();
    const sid = sessionId || (source + '_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8));

    if (eventType === 'lead_submit') {
      const prev = lpSessions[sid] || {};
      lpSessions[sid] = {
        id: sid, source, started_at: prev.started_at || ts,
        name: name || null, phone: phone || null, email: email || null,
        score: score !== undefined ? score : null,
        qualified: qualified || 'NO',
        answers: answers || {},
        utm_source: utms?.utm_source || '', utm_medium: utms?.utm_medium || '',
        utm_campaign: utms?.utm_campaign || '', utm_content: utms?.utm_content || '',
        utm_term: utms?.utm_term || '',
        fbclid: fbclid || '', fbc: fbc || '', fbp: fbp || '',
        furthest_step: prev.furthest_step || stepIndex || null,
        referrer: req.headers['referer'] || '', user_agent: req.headers['user-agent'] || ''
      };
      saveLPSessions();
      appendLPEvent({ sessionId: sid, source, eventType, ts });
    } else if (eventType === 'step_view') {
      if (!lpSessions[sid]) {
        lpSessions[sid] = {
          id: sid, source, started_at: ts, name: null, phone: null, email: null,
          score: null, qualified: null, answers: {},
          utm_source: '', utm_medium: '', utm_campaign: '', utm_content: '', utm_term: '',
          fbclid: '', fbc: '', fbp: '', furthest_step: stepIndex || 1,
          referrer: req.headers['referer'] || '', user_agent: req.headers['user-agent'] || ''
        };
      } else if ((stepIndex || 1) > (lpSessions[sid].furthest_step || 0)) {
        lpSessions[sid].furthest_step = stepIndex;
      }
      saveLPSessions();
      appendLPEvent({ sessionId: sid, source, eventType, stepIndex: stepIndex || 1, ts });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('LP Track error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── LP OVERVIEW ──
app.get('/api/lp/overview', (req, res) => {
  const { from, to, source } = req.query;
  let all = filterByDate(Object.values(lpSessions), from, to);
  if (source) all = all.filter(s => s.source === source);
  const submitted = all.filter(s => s.qualified !== null && s.qualified !== undefined);
  const total = submitted.length;
  const qual = submitted.filter(s => s.qualified === 'YES').length;
  const not_qual = submitted.filter(s => s.qualified === 'NO').length;
  const disqual = submitted.filter(s => s.qualified === 'DISQUALIFIED').length;
  const scores = submitted.filter(s => s.score !== null && s.score !== undefined).map(s => parseFloat(s.score));
  const avgScore = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : '0';
  const maxScore = scores.length ? Math.max(...scores) : 0;
  const minScore = scores.length ? Math.min(...scores) : 0;

  const scoreBuckets = [];
  if (scores.length && maxScore > minScore) {
    const bsz = (maxScore - minScore) / 5;
    for (let i = 0; i < 5; i++) {
      const lo = minScore + i * bsz, hi = minScore + (i + 1) * bsz;
      scoreBuckets.push({ range: `${lo.toFixed(0)}–${hi.toFixed(0)}`, count: scores.filter(s => i < 4 ? (s >= lo && s < hi) : (s >= lo && s <= hi)).length });
    }
  } else if (scores.length) {
    scoreBuckets.push({ range: `${minScore.toFixed(0)}`, count: scores.length });
  }

  const byDay = {};
  submitted.forEach(s => {
    const day = (s.started_at || '').slice(0, 10);
    if (!day) return;
    if (!byDay[day]) byDay[day] = { day, submissions: 0, qualified: 0 };
    byDay[day].submissions++;
    if (s.qualified === 'YES') byDay[day].qualified++;
  });
  const trend = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)).slice(-30);

  const utmMap = {};
  submitted.forEach(s => { const src = s.utm_source || 'direct'; utmMap[src] = (utmMap[src] || 0) + 1; });
  const utm_breakdown = Object.entries(utmMap).map(([src, count]) => ({ source: src, count })).sort((a, b) => b.count - a.count).slice(0, 10);

  res.json({
    total, qualified: qual, not_qualified: not_qual, disqualified: disqual,
    qual_rate: total ? ((qual / total) * 100).toFixed(1) : '0',
    avg_score: avgScore, max_score: maxScore,
    score_buckets: scoreBuckets, trend, utm_breakdown
  });
});

// ── LP FUNNEL ──
app.get('/api/lp/funnel', (req, res) => {
  const { from, to, source } = req.query;
  let allSess = filterByDate(Object.values(lpSessions), from, to);
  if (source) allSess = allSess.filter(s => s.source === source);
  const sessIds = new Set(allSess.map(s => s.id));
  const events = filterByDate(readLPEvents(), from, to, 'ts').filter(e => sessIds.has(e.sessionId) && e.eventType === 'step_view');

  const stepCounts = {};
  const seen = new Set();
  events.forEach(e => {
    const key = e.sessionId + '::' + e.stepIndex;
    if (!seen.has(key)) { seen.add(key); stepCounts[e.stepIndex] = (stepCounts[e.stepIndex] || 0) + 1; }
  });

  const submitted = allSess.filter(s => s.qualified !== null && s.qualified !== undefined).length;
  const STEP_NAMES = {
    delhi:     ['Q1: Course Interest', 'Q2: Investment', 'Q3: Commitment', 'Q4: Timeline', 'Q5: Financial', 'Contact Info'],
    hyderabad: ['Q1: Course Interest', 'Q2: Investment', 'Q3: Commitment', 'Q4: Timeline', 'Q5: Financial', 'Contact Info'],
    online:    ['Q1: Experience', 'Q2: Goal', 'Q3: Investment', 'Q4: Timeline', 'Contact Info']
  };
  const names = STEP_NAMES[source] || ['Step 1','Step 2','Step 3','Step 4','Step 5','Step 6'];
  const funnelSteps = names.map((name, i) => ({ name, step: i + 1, count: stepCounts[i + 1] || 0 }));
  funnelSteps.push({ name: 'Form Submitted', step: names.length + 1, count: submitted });

  res.json({ funnelSteps, total: allSess.length });
});

// ── LP ANSWERS ──
app.get('/api/lp/answers', (req, res) => {
  const { from, to, source } = req.query;
  let all = filterByDate(Object.values(lpSessions), from, to);
  if (source) all = all.filter(s => s.source === source && s.qualified !== null && s.qualified !== undefined);

  const grouped = {};
  all.forEach(s => {
    if (!s.answers) return;
    Object.entries(s.answers).forEach(([qId, ans]) => {
      if (!ans || !ans.value) return;
      if (!grouped[qId]) grouped[qId] = {};
      if (!grouped[qId][ans.value]) grouped[qId][ans.value] = { value: ans.value, label: ans.label || ans.value, count: 0 };
      grouped[qId][ans.value].count++;
    });
  });

  const questions = Object.entries(grouped).map(([qId, answers]) => ({
    questionId: qId,
    questionIndex: parseInt(qId.replace('q', '')) - 1,
    answers: Object.values(answers).sort((a, b) => b.count - a.count)
  })).sort((a, b) => a.questionIndex - b.questionIndex);

  res.json({ questions });
});

// ── LP LEADS ──
app.get('/api/lp/leads', (req, res) => {
  const { from, to, source, search, qualified, sort = 'started_at', order = 'desc', page = 1, limit = 50 } = req.query;
  let list = filterByDate(Object.values(lpSessions), from, to);
  if (source) list = list.filter(s => s.source === source && s.qualified !== null && s.qualified !== undefined);
  if (search) {
    const q = search.toLowerCase();
    list = list.filter(s => (s.name||'').toLowerCase().includes(q) || (s.phone||'').includes(q) || (s.email||'').toLowerCase().includes(q));
  }
  if (qualified && qualified !== '') list = list.filter(s => s.qualified === qualified);

  const validSorts = ['started_at', 'name', 'score', 'qualified'];
  const sc = validSorts.includes(sort) ? sort : 'started_at';
  list.sort((a, b) => {
    const va = a[sc] || 0, vb = b[sc] || 0;
    if (order === 'asc') return va > vb ? 1 : va < vb ? -1 : 0;
    return va < vb ? 1 : va > vb ? -1 : 0;
  });

  const total = list.length;
  const paged = list.slice((parseInt(page) - 1) * parseInt(limit), parseInt(page) * parseInt(limit));
  res.json({ total, page: parseInt(page), limit: parseInt(limit), leads: paged });
});

// ── LP EXPORT ──
app.get('/api/lp/export', (req, res) => {
  const { source } = req.query;
  let list = Object.values(lpSessions).filter(s => s.qualified !== null && s.qualified !== undefined);
  if (source) list = list.filter(s => s.source === source);

  const headers = ['Session ID','Date','Source','Name','Phone','Email','Score','Qualified',
    'Q1 Value','Q1 Label','Q2 Value','Q2 Label','Q3 Value','Q3 Label',
    'Q4 Value','Q4 Label','Q5 Value','Q5 Label',
    'UTM Source','UTM Medium','UTM Campaign','UTM Content','UTM Term'];
  const rows = list.map(s => {
    const a = s.answers || {};
    return [
      s.id, s.started_at?.slice(0,10), s.source,
      s.name||'', s.phone||'', s.email||'',
      s.score !== null ? s.score : '', s.qualified||'',
      a.q1?.value||'', a.q1?.label||'', a.q2?.value||'', a.q2?.label||'',
      a.q3?.value||'', a.q3?.label||'', a.q4?.value||'', a.q4?.label||'',
      a.q5?.value||'', a.q5?.label||'',
      s.utm_source||'', s.utm_medium||'', s.utm_campaign||'', s.utm_content||'', s.utm_term||''
    ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="tn-lp${source ? '-'+source : ''}.csv"`);
  res.send([headers.join(','), ...rows].join('\n'));
});

app.listen(PORT, () => {
  console.log(`✅ TN Analytics running at http://localhost:${PORT}`);
  console.log(`📊 Quiz Funnel:  http://localhost:${PORT}/analytics-dashboard.html`);
  console.log(`📊 Delhi LP:     http://localhost:${PORT}/delhi-dashboard.html`);
  console.log(`📊 Hyderabad LP: http://localhost:${PORT}/hyderabad-dashboard.html`);
  console.log(`📊 Online LP:    http://localhost:${PORT}/online-dashboard.html`);
  console.log(`💾 Data stored in: ${path.join(__dirname, 'data')}`);
});
