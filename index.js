require('dotenv').config();
const { Client, GatewayIntentBits, PermissionsBitField, EmbedBuilder } = require('discord.js');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Load abusive words dataset
const abusiveWordsDataset = fs.readFileSync('./abusive-words.txt', 'utf-8')
  .split('\n')
  .map(word => word.trim().toLowerCase())
  .filter(word => word.length > 0);

// Initialize Firebase
const serviceAccount = require(path.resolve(process.env.FIREBASE_CREDENTIALS));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// Configuration
const config = {
  spamThreshold: 5, // Number of messages in spamWindow to trigger spam detection
  spamWindow: 10000, // 10 seconds window for spam detection (in milliseconds)
  mentionLimit: 2, // Maximum allowed mentions per message
  allowedDomains: ['discord.com', 'discord.gg'], // Whitelisted domains
  usernameCheck: {
    enabled: true,
    autoKick: true,
    warningMessage: "Your username violates our server rules. Please change your Discord username and rejoin."
  },
  punishments: {
    1: { 
      type: 'WARN', 
      dm: '⚠️ **First Warning**\nYour message violated server rules.\nNext offense: 5-minute mute',
      channelMsg: '{user} received a warning (1/3)'
    },
    2: { 
      type: 'MUTE', 
      duration: 5 * 60 * 1000,
      dm: '🔇 **You have been muted for 5 minutes**\nReason: Repeated violations',
      channelMsg: '🔇 {user} muted for 5 minutes (2/3)'
    },
    3: { 
      type: 'BAN', 
      dm: '🚫 **You have been banned**\nReason: Multiple rule violations',
      channelMsg: '🚫 {user} banned (violations cleared)'
    }
  },
  linkPunishments: {
    1: {
      type: 'WARN',
      dm: '⚠️ **Link Warning**\nSending links is not allowed in this server.\nNext offense: 5-minute mute',
      channelMsg: '{user} received a warning for sending links (1/3)'
    },
    2: {
      type: 'MUTE',
      duration: 5 * 60 * 1000,
      dm: '🔇 **You have been muted for 5 minutes**\nReason: Repeated link sharing',
      channelMsg: '🔇 {user} muted for 5 minutes for sending links (2/3)'
    },
    3: {
      type: 'BAN',
      dm: '🚫 **You have been banned**\nReason: Multiple link sharing violations',
      channelMsg: '🚫 {user} banned for repeated link sharing (violations cleared)'
    }
  },
  mentionPunishments: {
    1: {
      type: 'WARN',
      dm: '⚠️ **Mention Warning**\nYou mentioned too many users in one message (max {limit} allowed).\nNext offense: 5-minute mute',
      channelMsg: '{user} received a warning for mass mentions (1/3)'
    },
    2: {
      type: 'MUTE',
      duration: 5 * 60 * 1000,
      dm: '🔇 **You have been muted for 5 minutes**\nReason: Repeated mass mentions',
      channelMsg: '🔇 {user} muted for 5 minutes for mass mentions (2/3)'
    },
    3: {
      type: 'BAN',
      dm: '🚫 **You have been banned**\nReason: Multiple mass mention violations',
      channelMsg: '🚫 {user} banned for repeated mass mentions (violations cleared)'
    }
  },
  spamPunishments: {
    1: {
      type: 'WARN',
      dm: '⚠️ **Spam Warning**\nPlease stop spamming messages.\nNext offense: 5-minute mute',
      channelMsg: '{user} received a warning for spamming (1/3)'
    },
    2: {
      type: 'MUTE',
      duration: 5 * 60 * 1000,
      dm: '🔇 **You have been muted for 5 minutes**\nReason: Repeated spamming',
      channelMsg: '🔇 {user} muted for 5 minutes for spamming (2/3)'
    },
    3: {
      type: 'BAN',
      dm: '🚫 **You have been banned**\nReason: Multiple spamming violations',
      channelMsg: '🚫 {user} banned for repeated spamming (violations cleared)'
    }
  }
};

// Spam tracking
const userMessageTimestamps = new Map();
const userSpamCounts = new Map();

client.once('ready', async () => {
  console.log(`🛡️ Moderation bot online as ${client.user.tag}`);
  console.log(`Loaded ${abusiveWordsDataset.length} abusive words from dataset`);
  
  // Verify permissions
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  const botPermissions = guild.members.me.permissions;
  
  const requiredPerms = new PermissionsBitField([
    'ManageMessages',
    'ModerateMembers',
    'BanMembers',
    'KickMembers'
  ]);

  if (!botPermissions.has(requiredPerms)) {
    console.error('❌ Missing critical permissions:', 
      botPermissions.missing(requiredPerms));
  }
});

client.on('guildMemberAdd', async (member) => {
  if (shouldIgnoreMember(member)) return;
  
  try {
    const hasAbusiveUsername = checkAbusiveUsername(member.user.username);
    if (hasAbusiveUsername) {
      await handleAbusiveUsername(member);
    }
  } catch (error) {
    console.error('Username check error:', error);
  }
});

client.on('messageCreate', async (message) => {
  if (shouldIgnoreMessage(message)) return;

  try {
    const violation = checkForViolations(message);
    if (violation) {
      console.log(`Violation detected from ${message.author.tag}:`, violation.type);
      await handleViolation(message, violation);
    }
  } catch (error) {
    console.error('Message processing error:', error);
  }
});

/* Core Functions */
function shouldIgnoreMember(member) {
  return member.user.bot || member.permissions.has('Administrator');
}

function shouldIgnoreMessage(message) {
  return message.author.bot || 
         !message.guild || 
         message.guild.id !== process.env.GUILD_ID ||
         message.member.permissions.has('Administrator');
}

function checkAbusiveUsername(username) {
  const lowerUsername = username.toLowerCase();
  return abusiveWordsDataset.some(word => {
    return lowerUsername.includes(word.toLowerCase()) || 
           lowerUsername === word.toLowerCase();
  });
}

async function handleAbusiveUsername(member) {
  try {
    // Send DM to user
    await member.user.send({
      content: config.usernameCheck.warningMessage,
      embeds: [
        new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle("Username Violation")
          .setDescription("Your username contains prohibited content.")
          .addFields(
            { name: "Current Username", value: member.user.username },
            { name: "How to fix", value: "Change your Discord username in User Settings > Edit Profile" }
          )
      ]
    }).catch(() => {}); // Ignore if DMs are closed

    // Log the action
    const logEmbed = new EmbedBuilder()
      .setColor(0xFFA500)
      .setTitle("Username Violation Detected")
      .setDescription(`Blocked user with inappropriate username`)
      .addFields(
        { name: "User", value: `${member.user.tag} (${member.id})` },
        { name: "Username", value: member.user.username },
        { name: "Action", value: config.usernameCheck.autoKick ? "Kicked" : "Warning Sent" }
      )
      .setTimestamp();

    // Find your moderation log channel
    const logChannel = member.guild.channels.cache.get(process.env.MOD_LOG_CHANNEL);
    if (logChannel) {
      await logChannel.send({ embeds: [logEmbed] });
    }

    // Take action based on config
    if (config.usernameCheck.autoKick) {
      await member.kick("Automatic kick: Username violation");
    }
  } catch (error) {
    console.error("Failed to handle abusive username:", error);
  }
}

function detectLinks(content) {
  // Common URL patterns
  const urlRegex = /https?:\/\/[^\s]+|www\.[^\s]+/gi;
  const matches = content.match(urlRegex) || [];
  
  // Filter out allowed domains
  return matches.filter(link => {
    try {
      const domain = new URL(link.startsWith('http') ? link : `http://${link}`).hostname.replace('www.', '');
      return !config.allowedDomains.includes(domain);
    } catch {
      return true; // If URL parsing fails, assume it's not allowed
    }
  });
}

function checkForViolations(message) {
  const lowerContent = message.content.toLowerCase();
  
  // Check for mass mentions
  const mentionCount = message.mentions.users.size;
  if (mentionCount > config.mentionLimit) {
    return { 
      type: 'MASS_MENTION', 
      details: `Mentioned ${mentionCount} users (max ${config.mentionLimit} allowed)`
    };
  }

  // Check for disallowed links
  const detectedLinks = detectLinks(message.content);
  if (detectedLinks.length > 0) {
    return { 
      type: 'DISALLOWED_LINK', 
      details: `Sent ${detectedLinks.length} links: ${detectedLinks.join(', ')}`
    };
  }

  // Check against abusive words dataset
  const abusiveWordFound = abusiveWordsDataset.some(word => {
    return lowerContent.includes(word.toLowerCase());
  });

  if (abusiveWordFound) {
    return { type: 'ABUSIVE_LANGUAGE', details: 'Matched abusive words dataset' };
  }

  // Enhanced Spam Detection
  const now = Date.now();
  const userId = message.author.id;
  
  // Get user's message timestamps
  const userTimestamps = userMessageTimestamps.get(userId) || [];
  
  // Filter messages within the spam window
  const recentMessages = userTimestamps.filter(t => now - t < config.spamWindow);
  
  // Update timestamps
  userMessageTimestamps.set(userId, [...recentMessages, now]);
  
  // Check if user exceeded the threshold
  if (recentMessages.length >= config.spamThreshold) {
    // Get current spam count
    const spamCount = userSpamCounts.get(userId) || 0;
    const newSpamCount = spamCount + 1;
    userSpamCounts.set(userId, newSpamCount);
    
    // Reset the timestamps to prevent immediate re-trigger
    userMessageTimestamps.set(userId, []);
    
    return { 
      type: 'SPAM', 
      details: `${recentMessages.length} messages in ${config.spamWindow/1000}s`,
      count: newSpamCount
    };
  }

  return null;
}

async function handleViolation(message, violation) {
  // 1. Delete the offending message
  await message.delete().catch(() => {});

  // 2. Update violation count
  const userRef = db.collection('violations').doc(message.author.id);
  const doc = await userRef.get();
  
  // Determine violation type and select appropriate punishment track
  let countField, punishmentConfig;
  
  if (violation.type === 'DISALLOWED_LINK') {
    countField = 'linkViolations';
    punishmentConfig = config.linkPunishments;
  } else if (violation.type === 'MASS_MENTION') {
    countField = 'mentionViolations';
    punishmentConfig = config.mentionPunishments;
  } else if (violation.type === 'SPAM') {
    countField = 'spamViolations';
    punishmentConfig = config.spamPunishments;
  } else {
    countField = 'count';
    punishmentConfig = config.punishments;
  }

  const currentCount = doc.exists ? doc.data()[countField] || 0 : 0;
  const newCount = violation.count || currentCount + 1;

  await userRef.set({
    username: message.author.tag,
    userId: message.author.id,
    [countField]: newCount,
    lastViolation: {
      type: violation.type,
      details: violation.details,
      content: message.content,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    }
  }, { merge: true });

  // Customize DM message for mention violations
  if (violation.type === 'MASS_MENTION' && punishmentConfig[1]?.dm) {
    punishmentConfig = JSON.parse(JSON.stringify(punishmentConfig)); // Deep clone
    punishmentConfig[1].dm = punishmentConfig[1].dm.replace('{limit}', config.mentionLimit);
  }

  await applyPunishment(
    message, 
    newCount, 
    violation.type,
    punishmentConfig
  );
}

async function applyPunishment(message, violationCount, violationType, punishmentConfig = config.punishments) {
  const punishment = punishmentConfig[Math.min(violationCount, 3)];
  
  try {
    // Send DM notification
    if (punishment.dm) {
      await message.author.send(punishment.dm).catch(() => {
        message.channel.send(`${message.author}, please enable DMs for warnings`).catch(() => {});
      });
    }

    // Take action
    switch (punishment.type) {
      case 'MUTE':
        await message.member.timeout(
          punishment.duration,
          `Automod: ${violationCount} violations (${violationType})`
        );
        break;
        
      case 'BAN':
        await message.member.ban({
          reason: `Automod: ${violationCount} violations (${violationType})`,
          deleteMessageDays: 1
        });
        
        // Clear all violation counts
        await db.collection('violations').doc(message.author.id).delete();
        userSpamCounts.delete(message.author.id);
        userMessageTimestamps.delete(message.author.id);
        console.log(`🧹 Cleared all violations for ${message.author.tag}`);
        break;
    }

    // Log to channel
    const embed = new EmbedBuilder()
      .setColor(punishment.type === 'BAN' ? 0xFF0000 : 0xFFA500)
      .setDescription(punishment.channelMsg.replace('{user}', message.author.username))
      .addFields({
        name: 'Violation Details',
        value: `Type: ${violationType}\nCount: ${violationCount}/3`
      });
    
    await message.channel.send({ 
      embeds: [embed],
      allowedMentions: { users: [] } 
    });

  } catch (error) {
    console.error(`Punishment failed for ${violationType}:`, error);
    
    const errorEmbed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setDescription(`❌ Failed to ${punishment.type.toLowerCase()} ${message.author.username}: ${error.message}`);
    
    await message.channel.send({ embeds: [errorEmbed] });
  }
}

// Unban Command with Fresh Start
client.on('messageCreate', async (message) => {
  if (!message.content.startsWith('!unban') || 
      !message.member?.permissions.has(PermissionsBitField.Flags.BanMembers)) return;

  const args = message.content.split(' ');
  if (args.length < 2) return message.reply('❌ Please provide a user ID: `!unban USER_ID`');

  const userId = args[1].replace(/[<@!>]/g, '');

  try {
    // 1. Check if user is banned
    await message.guild.bans.fetch(userId);
    
    // 2. Unban the user
    await message.guild.bans.remove(userId);
    
    // 3. Create fresh record
    await db.collection('violations').doc(userId).set({
      username: `Previously banned user (${userId})`,
      userId: userId,
      count: 0,
      lastUnban: admin.firestore.FieldValue.serverTimestamp()
    });

    // 4. Clear any in-memory spam tracking
    userSpamCounts.delete(userId);
    userMessageTimestamps.delete(userId);

    // 5. Confirm
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setDescription(`✅ Successfully unbanned <@${userId}> with fresh start (violations reset to 0)`);
    
    await message.reply({ embeds: [embed] });

  } catch (error) {
    console.error('Unban Error:', error);
    
    const errorMsg = error.code === 10026 ? 
      'User is not banned' : 
      `Failed: ${error.message}`;
    
    const errorEmbed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setDescription(`❌ ${errorMsg}`);
    
    await message.reply({ embeds: [errorEmbed] });
  }
});

client.login(process.env.DISCORD_TOKEN);