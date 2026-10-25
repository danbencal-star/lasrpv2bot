const fs = require('fs');
const path = require('path');
const { SlashCommandBuilder, MessageFlags } = require('discord.js');

/* ------------------------------------------------------------------ */
/*  SETTINGS                                                           */
/* ------------------------------------------------------------------ */

// Only members with this role can use any /shift command
const SHIFT_ROLE_ID = '1555284465318764724';

// The roles given while on shift (created automatically if they don't exist)
const ON_DUTY_ROLE_NAME = 'On Duty';
const ON_BREAK_ROLE_NAME = 'On Break';
const ON_DUTY_COLOUR = 0x57f287; // green
const ON_BREAK_COLOUR = 0xfee75c; // yellow

// Optional: a channel ID where every shift start / break / end is also logged.
// Leave '' for none.
const SHIFT_LOG_CHANNEL_ID = '';

const LEADERBOARD_SIZE = 10;
const HISTORY_DAYS = 120; // how long individual shifts are kept (all-time totals are kept forever)

const DATA_FILE = path.join(__dirname, '..', 'data', 'shifts.json');

// panel stripe colours
const COLOURS = {
  start: 0x57f287,
  break: 0xfee75c,
  resume: 0x57f287,
  end: 0xed4245,
  status: 0x2563eb,
  leaderboard: 0x2563eb,
};

/* ------------------------------------------------------------------ */
/*  Emojis: the bot looks through YOUR server's emojis and picks the   */
/*  one whose name matches. If nothing matches it uses a normal emoji. */
/* ------------------------------------------------------------------ */
const EMOJI_SEARCH = {
  start: { keywords: ['clockin', 'shiftstart', 'startshift', 'onduty', 'start', 'play', 'online'], fallback: '🟢' },
  break: { keywords: ['onbreak', 'break', 'pause', 'coffee', 'idle', 'away', 'brb'], fallback: '🟡' },
  resume: { keywords: ['resume', 'return', 'back', 'play'], fallback: '▶️' },
  end: { keywords: ['clockout', 'shiftend', 'endshift', 'stop', 'end', 'offline'], fallback: '🔴' },
  time: { keywords: ['stopwatch', 'timer', 'time', 'clock', 'hourglass'], fallback: '⏱️' },
  shifts: { keywords: ['shifts', 'calendar', 'shift'], fallback: '📅' },
  leaderboard: { keywords: ['leaderboard', 'trophy', 'crown', 'winner', 'rank', 'top'], fallback: '🏆' },
  status: { keywords: ['status', 'info'], fallback: 'ℹ️' },
};

function nameTokens(name) {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function pickEmoji(guild, key) {
  const { keywords, fallback } = EMOJI_SEARCH[key];
  const all = [...guild.emojis.cache.values()].filter((e) => e.available !== false);

  for (const keyword of keywords) {
    const found = all.find(
      (e) =>
        nameTokens(e.name).includes(keyword) ||
        e.name.toLowerCase().replace(/[^a-z0-9]/g, '') === keyword
    );
    if (found) return found.toString();
  }
  return fallback;
}

/* ------------------------------------------------------------------ */
/*  Saved shift data                                                   */
/* ------------------------------------------------------------------ */
function load() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    data.members ||= {};
    data.history ||= [];
    return data;
  } catch {
    return { members: {}, history: [] };
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function newEntry() {
  return { totalMs: 0, breakMs: 0, shifts: 0, current: null };
}

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */
const sec = (ms) => Math.floor(ms / 1000);

// 3725000 -> "1h 2m", 95000 -> "1m 35s", 12000 -> "12s"
function fmt(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours >= 1) return `${hours}h ${minutes}m`;
  if (minutes >= 1) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// time actually worked in a shift so far (breaks excluded)
function liveWork(current, now) {
  const onBreakNow = current.breakStartedAt ? now - current.breakStartedAt : 0;
  return Math.max(0, now - current.startedAt - current.breakMs - onBreakNow);
}

function panel(colour, text) {
  return {
    type: 17,
    accent_color: colour,
    components: [{ type: 10, content: text }],
  };
}

function panelMessage(p) {
  return {
    components: [p],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

function deny(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

// finds the On Duty / On Break role, or makes it if it doesn't exist
async function getRole(guild, name, colour, notes) {
  let role = guild.roles.cache.find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (role) return role;

  try {
    role = await guild.roles.create({
      name,
      color: colour,
      hoist: false,
      mentionable: false,
      reason: 'Shift system',
    });
    return role;
  } catch (err) {
    console.error(`[SHIFT] Couldn't create the "${name}" role:`, err.message);
    notes.push(`I couldn't create the **${name}** role. Check I have **Manage Roles**.`);
    return null;
  }
}

// gives / removes roles and reports anything that failed
async function changeRoles(member, { add = [], remove = [] }, notes) {
  for (const role of remove) {
    if (!role || !member.roles.cache.has(role.id)) continue;
    if (!role.editable) {
      notes.push(`I can't remove **${role.name}** — move my bot role above it.`);
      continue;
    }
    await member.roles.remove(role, 'Shift system').catch((err) => {
      console.error('[SHIFT] Role remove failed:', err.message);
      notes.push(`I couldn't remove **${role.name}**.`);
    });
  }

  for (const role of add) {
    if (!role || member.roles.cache.has(role.id)) continue;
    if (!role.editable) {
      notes.push(`I can't give **${role.name}** — move my bot role above it.`);
      continue;
    }
    await member.roles.add(role, 'Shift system').catch((err) => {
      console.error('[SHIFT] Role add failed:', err.message);
      notes.push(`I couldn't give **${role.name}**.`);
    });
  }
}

async function sendLog(client, interaction, message) {
  if (!SHIFT_LOG_CHANNEL_ID || SHIFT_LOG_CHANNEL_ID === interaction.channelId) return;

  const channel = await client.channels.fetch(SHIFT_LOG_CHANNEL_ID).catch(() => null);
  if (channel) await channel.send(message).catch(() => {});
}

/* ------------------------------------------------------------------ */
/*  /shift start | break | resume | end                                */
/* ------------------------------------------------------------------ */
async function handleAction(interaction, action) {
  const guild = interaction.guild;
  const member = interaction.member;
  const now = Date.now();

  const data = load();
  const entry = (data.members[member.id] ||= newEntry());
  const current = entry.current;

  // ---- checks ----
  if (action === 'start' && current) {
    return deny(
      interaction,
      current.breakStartedAt
        ? '❌ You\'re already on a shift and currently on break. Use `/shift resume` to come back or `/shift end` to finish.'
        : `❌ You're already on a shift (started <t:${sec(current.startedAt)}:R>).`
    );
  }
  if (action !== 'start' && !current) {
    return deny(interaction, '❌ You\'re not on a shift. Start one with `/shift start`.');
  }
  if (action === 'break' && current.breakStartedAt) {
    return deny(interaction, '❌ You\'re already on break. Use `/shift resume` when you\'re back.');
  }
  if (action === 'resume' && !current.breakStartedAt) {
    return deny(interaction, '❌ You\'re not on break.');
  }

  await interaction.deferReply();

  const notes = [];
  const E = (key) => pickEmoji(guild, key);
  let text;
  let colour;
  let roleChanges;

  const dutyRole = await getRole(guild, ON_DUTY_ROLE_NAME, ON_DUTY_COLOUR, notes);
  const breakRole = await getRole(guild, ON_BREAK_ROLE_NAME, ON_BREAK_COLOUR, notes);

  /* ---------------- start ---------------- */
  if (action === 'start') {
    entry.current = { startedAt: now, breakStartedAt: null, breakMs: 0 };
    colour = COLOURS.start;
    roleChanges = { add: [dutyRole], remove: [breakRole] };

    text =
      `## ${E('start')}┃Shift Started\n` +
      `**Staff:** <@${member.id}>\n` +
      `**Started:** <t:${sec(now)}:t> (<t:${sec(now)}:R>)\n` +
      `**Status:** On Duty`;
  }

  /* ---------------- break ---------------- */
  if (action === 'break') {
    const worked = liveWork(current, now);
    current.breakStartedAt = now;
    colour = COLOURS.break;
    roleChanges = { add: [breakRole], remove: [dutyRole] };

    text =
      `## ${E('break')}┃On Break\n` +
      `**Staff:** <@${member.id}>\n` +
      `**Break started:** <t:${sec(now)}:t>\n` +
      `${E('time')} **Worked so far:** ${fmt(worked)}\n` +
      `**Status:** On Break`;
  }

  /* ---------------- resume ---------------- */
  if (action === 'resume') {
    const breakLength = now - current.breakStartedAt;
    current.breakMs += breakLength;
    current.breakStartedAt = null;
    colour = COLOURS.resume;
    roleChanges = { add: [dutyRole], remove: [breakRole] };

    text =
      `## ${E('resume')}┃Back On Duty\n` +
      `**Staff:** <@${member.id}>\n` +
      `**Break length:** ${fmt(breakLength)}\n` +
      `${E('time')} **Worked so far:** ${fmt(liveWork(current, now))}\n` +
      `**Status:** On Duty`;
  }

  /* ---------------- end ---------------- */
  if (action === 'end') {
    // finish a break that was still running
    if (current.breakStartedAt) {
      current.breakMs += now - current.breakStartedAt;
      current.breakStartedAt = null;
    }

    const total = now - current.startedAt;
    const breakMs = current.breakMs;
    const workMs = Math.max(0, total - breakMs);

    entry.totalMs += workMs;
    entry.breakMs += breakMs;
    entry.shifts += 1;
    entry.current = null;

    data.history.push({
      userId: member.id,
      start: current.startedAt,
      end: now,
      workMs,
      breakMs,
    });

    // forget very old individual shifts (all-time totals stay)
    const keepAfter = now - HISTORY_DAYS * 24 * 60 * 60 * 1000;
    data.history = data.history.filter((h) => h.end >= keepAfter);

    colour = COLOURS.end;
    roleChanges = { add: [], remove: [dutyRole, breakRole] };

    text =
      `## ${E('end')}┃Shift Ended\n` +
      `**Staff:** <@${member.id}>\n` +
      `${E('time')} **Shift length:** ${fmt(workMs)} *(breaks not counted)*\n` +
      `**Time on break:** ${fmt(breakMs)}\n` +
      `**Started:** <t:${sec(current.startedAt)}:t> • **Ended:** <t:${sec(now)}:t>\n\n` +
      `${E('shifts')} **Total shifts:** ${entry.shifts}\n` +
      `${E('time')} **Total time on duty:** ${fmt(entry.totalMs)}`;
  }

  save(data);

  await changeRoles(member, roleChanges, notes);

  if (notes.length) {
    text += `\n\n${notes.map((n) => `-# ⚠️ ${n}`).join('\n')}`;
  }

  const message = panelMessage(panel(colour, text));
  await interaction.editReply(message);
  await sendLog(interaction.client, interaction, message);
}

/* ------------------------------------------------------------------ */
/*  /shift status                                                      */
/* ------------------------------------------------------------------ */
async function showStatus(interaction) {
  const guild = interaction.guild;
  const user = interaction.options.getUser('user') || interaction.user;
  const now = Date.now();

  const entry = load().members[user.id] || newEntry();
  const current = entry.current;
  const E = (key) => pickEmoji(guild, key);

  let state = 'Off Duty';
  let live = '';

  if (current) {
    state = current.breakStartedAt ? 'On Break' : 'On Duty';
    live =
      `**Shift started:** <t:${sec(current.startedAt)}:R>\n` +
      `${E('time')} **Worked this shift:** ${fmt(liveWork(current, now))}\n`;
  }

  const text =
    `## ${E('status')}┃Shift Status\n` +
    `**Staff:** <@${user.id}>\n` +
    `**Status:** ${state}\n` +
    live +
    `\n${E('shifts')} **Total shifts:** ${entry.shifts}\n` +
    `${E('time')} **Total time on duty:** ${fmt(entry.totalMs)}\n` +
    `**Total break time:** ${fmt(entry.breakMs)}`;

  return interaction.reply(panelMessage(panel(COLOURS.status, text)));
}

/* ------------------------------------------------------------------ */
/*  /shift leaderboard                                                 */
/* ------------------------------------------------------------------ */
async function showLeaderboard(interaction) {
  const guild = interaction.guild;
  const period = interaction.options.getString('period') || 'week';
  const now = Date.now();

  const labels = { week: 'This Week', month: 'This Month', all: 'All Time' };
  const cutoff =
    period === 'week'
      ? now - 7 * 24 * 60 * 60 * 1000
      : period === 'month'
      ? now - 30 * 24 * 60 * 60 * 1000
      : 0;

  const data = load();

  // add up finished shifts per person for the chosen period
  const fromHistory = {};
  if (period !== 'all') {
    for (const h of data.history) {
      if (h.end < cutoff) continue;
      const row = (fromHistory[h.userId] ||= { work: 0, shifts: 0 });
      row.work += h.workMs;
      row.shifts += 1;
    }
  }

  const rows = [];
  for (const [userId, entry] of Object.entries(data.members)) {
    let work = period === 'all' ? entry.totalMs : fromHistory[userId]?.work || 0;
    const shifts = period === 'all' ? entry.shifts : fromHistory[userId]?.shifts || 0;

    // include a shift that's still running
    if (entry.current) work += liveWork(entry.current, now);

    if (work > 0 || shifts > 0) {
      rows.push({
        userId,
        work,
        shifts,
        state: entry.current ? (entry.current.breakStartedAt ? 'break' : 'duty') : null,
      });
    }
  }

  rows.sort((a, b) => b.work - a.work);
  const top = rows.slice(0, LEADERBOARD_SIZE);

  const medals = ['🥇', '🥈', '🥉'];
  const lines = top.map((row, i) => {
    const place = medals[i] || `**${i + 1}.**`;
    const live = row.state === 'duty' ? ' • 🟢 on duty' : row.state === 'break' ? ' • 🟡 on break' : '';
    return `${place} <@${row.userId}> — **${fmt(row.work)}** • ${row.shifts} shift${row.shifts === 1 ? '' : 's'}${live}`;
  });

  const text =
    `## ${pickEmoji(guild, 'leaderboard')}┃Shift Leaderboard — ${labels[period]}\n\n` +
    (lines.length ? lines.join('\n') : '*No shifts have been logged yet.*') +
    `\n\n-# Time on duty only. Breaks are not counted.`;

  return interaction.reply(panelMessage(panel(COLOURS.leaderboard, text)));
}

/* ------------------------------------------------------------------ */
/*  The command                                                        */
/* ------------------------------------------------------------------ */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('shift')
    .setDescription('Shift management')
    .setDMPermission(false)
    .addSubcommand((sub) => sub.setName('start').setDescription('Start your shift and go on duty'))
    .addSubcommand((sub) => sub.setName('break').setDescription('Go on break'))
    .addSubcommand((sub) => sub.setName('resume').setDescription('Come back from your break'))
    .addSubcommand((sub) => sub.setName('end').setDescription('End your shift and go off duty'))
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('See your shift status and totals')
        .addUserOption((o) =>
          o.setName('user').setDescription('Check someone else instead').setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('leaderboard')
        .setDescription('See who has the most time on duty')
        .addStringOption((o) =>
          o
            .setName('period')
            .setDescription('Which period to show (default: this week)')
            .setRequired(false)
            .addChoices(
              { name: 'This Week', value: 'week' },
              { name: 'This Month', value: 'month' },
              { name: 'All Time', value: 'all' }
            )
        )
    ),

  async execute(interaction) {
    const guild = interaction.guild;

    // only people with the shift role (or the server owner) can use this
    const allowed =
      interaction.user.id === guild.ownerId || interaction.member.roles.cache.has(SHIFT_ROLE_ID);

    if (!allowed) {
      return deny(interaction, '❌ You don\'t have permission to use shift commands.');
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'leaderboard') return showLeaderboard(interaction);
    if (sub === 'status') return showStatus(interaction);
    return handleAction(interaction, sub);
  },
};