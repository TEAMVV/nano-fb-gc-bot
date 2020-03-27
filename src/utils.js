const fs = require("fs"); // File system
const request = require("request"); // For HTTP requests
const jimp = require("jimp"); // For image processing
const chrono = require("chrono-node"); // For NL date parsing
const config = require("./config");
const utils = require("./configutils");
const commands = require("./commands");
let gapi;
let mem;
let credentials;
let lockedThreads = [];

// Initialize the global variables in this module
// MUST be called before other functions in this module
// Values to be initialized: api instance, memjs instance,
// credentials object
exports.setglobals = (api, gmem, gcreds) => {
    gapi = api;
    mem = gmem;
    credentials = gcreds;
}

// Assorted utility functions

/*
This is used in place of (or in conjunction with) a regex for command matching.
It combines any passed regular expressions with a capturing group that looks for
a username (or alias) match and returns a regex match object containing the username
of the person matched (even if an alias was used – the function handles aliases on its
own and converts them back to usernames) in the order described below.

It takes a `command` (a regex object to be matched *before* the username), the `message` to be
searched, the `fromUserId` of the sender (for converting "me" to a username), the group's
`groupData` object, whether the username match should be `optional` (default `false`), any
separator `sep` to be placed between the prefix match and the username (default 1 space), and
any `suffix` match to be matched *after* the username match.

Returns a RegExp match object containing the matches in the following order:
1. {prefix match(es)}
2. {username match}
3. {suffix match(es)}
*/
exports.matchesWithUser = (command, message, fromUserId, groupData, optional = false, sep = " ", suffix = "") => {
    // Construct regex string
    let match = message.match(new RegExp(`${command.source}${optional ? "(?:" : ""}${sep}${groupData.userRegExp}${optional ? ")?" : ""}${suffix}`, "i"));
    if (match) {
        // Preserve properties
        const index = match.index;
        const input = match.input;
        for (let i = 1; i < match.length; i++) { // Start offset one to skip full match at [0]
            let m = match[i];
            if (m) { // Make sure only modifying the user field (no aliases here)
                // Any post-match changes that need to be made
                let fixes = exports.parseNameReplacements(m, fromUserId, groupData);
                match[i] = fixes;
                if (m != fixes) {
                    /*
                    NOTE: If a username has been replaced, no more changes are needed
                    The username change should always be the first (and only) change
                    to trigger this block, but it may not always be (esp. for future commands)
                    so be careful and revisit this if a better solution can be found (nothing else
                    has worked thus far).

                    For instance, I had to update the "score" command after implementing this since it
                    had an erroneous capturing group that contained a username before the main username field.
                    */
                    break;
                }
            }
        }
        match.index = index;
        match.input = input;
    }
    return match;
}

/*
Wrapper function for sending messages easily
Isn't that much simpler than the actual message function, but it
allows for an optional thread parameter (default is currently stored ID)
and for outputting messages to stdout when the API isn't available (e.g. before login)

Accepts either a simple string or a message object with URL/attachment fields.

Probably a good idea to use this wrapper for all sending instances for debug purposes
and consistency.
*/
exports.sendMessage = (m, threadId, callback = () => { }, replyId = null, api = gapi) => {
    if (!m || !threadId) {
        return callback(new Error("Must provide message and threadId."));
    }

    try {
        api.sendMessage(m, threadId, (err, minfo) => {
            callback(err, minfo);

            // Save last message ID sent
            exports.getGroupInfo(threadId, (err, info) => {
                if (minfo && info) {
                    if (err) return console.error(err);

                    exports.setGroupProperty("lastBotMessageID", minfo.messageID, info);
                }
            });
        }, replyId);
    } catch (e) { // For debug mode (API not available)
        console.log(`${threadId}: ${m}`);
        callback();
    }
}

// Wrapper function for sending error messages to chat (uses sendMessage wrapper)
exports.sendError = (m, threadId) => {
    exports.sendMessage(`Error: ${m}`, threadId);
}

/*
Wrapper function for using mentions
Mentions parameter is an array of dictionaries for each mention
Each dict contains "tag" and "id" keys that should be set to
the text and the id of the mention respectively
*/
exports.sendMessageWithMentions = (message, mentions, threadId) => {
    exports.sendMessage({
        "body": message,
        "mentions": mentions,
    }, threadId);
}

// Kick user for an optional length of time in seconds (default indefinitely)
// Also accepts optional callback parameter if length is specified
exports.kick = (userId, info, time, callback = () => { }, api = gapi) => {
    if (userId != config.bot.id) { // Never allow bot to be kicked
        api.removeUserFromGroup(userId, info.threadId, (err) => {
            if (err) {
                if (info.isGroup) {
                    let admins = info.admins.map(id => info.names[id]);
                    exports.sendError(`The bot must be an admin to kick members from the chat. Try asking ${admins.join("/")} to promote the bot.`, info.threadId);
                } else {
                    exports.sendError("Cannot kick user from private chat.", info.threadId);
                }
            } else {
                if (time) {
                    setTimeout(() => {
                        exports.addUser(userId, info, false); // Don't welcome if they're not new to the group
                        callback();
                    }, time * 1000);
                }
                exports.updateGroupInfo(info.threadId);
            }
        });
    }
}

// Same as kick, but for a list of users
exports.kickMultiple = (userIds, info, time, callback = () => { }, api = gapi) => {
    // Check if kicking is possible first to avoid duplicate error messages
    if (!info.isGroup) {
        exports.sendError("Cannot kick user from private chat.", info.threadId);
    } else if (info.admins.indexOf(config.bot.id) < 0) {
        let admins = info.admins.map(id => info.names[id]);
        exports.sendError(`The bot must be an admin to kick members from the chat. Try asking ${admins.join("/")} to promote the bot.`, info.threadId);
    } else {
        let callbackset = false;
        for (let i = 0; i < userIds.length; i++) {
            // Bot should never be in members list, but this is a safeguard
            // (ALSO VERY IMPORTANT so that group isn't completely emptied)
            if (userIds[i] != config.bot.id) {
                if (!callbackset) { // Only want to send the message once
                    exports.kick(userIds[i], info, time, callback);
                    callbackset = true;
                } else {
                    exports.kick(userIds[i], info, time);
                }
            }
        }
    }
}

/*
Adds user to group and updates members list
Optional parameter to welcome new user to the group
Buffer limit controls number of times it will attempt to add the user to the group
Optional parameter to control whether it should retry adding if it fails initially
if not successful on the first attempt (default 5)
*/
exports.addUser = (id, info, welcome = true, callback = () => { }, retry = true, currentBuffer = 0, api = gapi) => {
    api.addUserToGroup(id, info.threadId, err => {
        if (!err) {
            exports.updateGroupInfo(info.threadId, null, (err, info) => {
                if (!err && welcome) {
                    if (info.names[id]) {
                        exports.welcomeToChat(info.names[id], info);
                    } else {
                        api.getUserInfo(id, (err, uinfo) => {
                            if (!err && uinfo.name) {
                                exports.sendMessage(`${uinfo.name} will be added to ${info.name} pending admin approval.`, info.threadId);
                            }
                        });
                    }
                }
            });
            callback();
        } else if (err && (currentBuffer < config.addBufferLimit)) {
            if (retry) {
                exports.addUser(id, info, welcome, callback, retry, (currentBuffer + 1));
            } else {
                callback(err);
            }
        } else {
            callback(err);
        }
    });
}

// Utility func for welcoming users to the chat
exports.welcomeToChat = (name, groupInfo) => {
    let msg = `Welcome to ${groupInfo.name}, ${name}!`;
    if (groupInfo.pinned) {
        const introPin = groupInfo.pinned[config.introPin];
        if (introPin) {
            msg += `\nHere's some information about this chat:\n\n${introPin}`;
        }
    }

    exports.sendMessage(msg, groupInfo.threadId);
}

/*
Update stored info about groups after every message in the background
Takes an optional message object when called by the update subroutine,
but can be ignored when called from anywhere else.

Using callback is discouraged as the idea of this function is to update in
the background to decrease lag, but it may be useful if updates are required
to continue.
*/
exports.updateGroupInfo = (threadId, message, callback = () => { }, api = gapi) => {
    exports.getGroupInfo(threadId, (err, existingInfo) => {
        exports.getGroupInfo(config.owner.id, (ownerErr, ownerData) => {
            if (!err && !ownerErr) {
                // If the dbFailSilently flag is turned on, only send the init
                // message if the owner thread exists in the database.
                const shouldSendMessage = !config.dbFailSilently || ownerData;

                let isNew = false;
                if (!existingInfo) {
                    const n = config.bot.names; // Bot name info

                    // Group not yet registered
                    isNew = true;


                    if (shouldSendMessage) {
                        exports.sendMessage(`Hello! I'm ${n.long}${n.short ? `, but you can call me ${n.short}` : ""}. Give me a moment to collect some information about this chat before you use any commands.`, threadId);

                        // Add bot's nickname if available
                        api.changeNickname(n.short, threadId, config.bot.id); // Won't do anything if undefined
                    }

                    api.muteThread(threadId, -1); // Mute chat
                }
                api.getThreadInfo(threadId, (err, data) => {
                    if (data) {
                        let info = existingInfo || {};
                        info.threadId = threadId;
                        info.lastMessage = message;
                        info.name = data.threadName || config.defaultTitle;
                        info.emoji = data.emoji;
                        info.image = data.imageSrc;
                        info.color = data.color ? `#${data.color}` : null;
                        if (data.nicknames && data.nicknames[config.bot.id]) { // Don't add bot to nicknames list
                            delete data.nicknames[config.bot.id];
                        }
                        info.nicknames = data.nicknames || {};
                        info.admins = data.adminIDs ? data.adminIDs.map(u => u["id"]) : [];
                        if (isNew) {
                            // These properties only need to be initialized once
                            info.muted = true;
                            info.playlists = {};
                            info.aliases = {};
                            info.pinned = {};
                            info.events = {};
                            info.isGroup = data.isGroup;
                        }
                        api.getUserInfo(data.participantIDs, (err, userData) => {
                            if (!err) {
                                info.members = {};
                                info.names = {};
                                for (let id in userData) {
                                    if (userData.hasOwnProperty(id) && id != config.bot.id) { // Very important to not add bot to participants list
                                        info.members[userData[id].firstName.toLowerCase()] = id;
                                        info.names[id] = userData[id].firstName;
                                    }
                                }
                                // Set regex to search for member first names and any included aliases
                                const aliases = Object.keys(info.aliases).map((n) => {
                                    return info.aliases[n];
                                });
                                const matches = Object.keys(info.members);
                                info.userRegExp = utils.getRegexFromMembers(matches.concat(aliases));
                                // Attempt to give chat a more descriptive name than "Unnamed chat" if possible
                                if (info.name == config.defaultTitle) {
                                    let names = Object.keys(info.names).map((n) => {
                                        return info.names[n];
                                    });
                                    info.name = names.join("/") || "Unnamed chat";
                                }

                                if (isNew && shouldSendMessage) {
                                    // Alert owner now that chat name is available
                                    exports.sendMessage(`Bot added to new chat: "${info.name}".`, config.owner.id);
                                }
                            }
                            exports.setGroupInfo(info, (err) => {
                                if (!existingInfo && shouldSendMessage) {
                                    exports.sendMessage(`All done! Use '${config.trigger} help' to see what I can do.`, threadId);
                                }
                                callback(err, info);
                            });
                        });
                    } else {
                        // Errors are logged here despite being a utility func b/c errors here are critical
                        console.log(new Error(`Thread info not found for ${threadId}`));
                        console.log(err);
                        callback(err);
                    }
                });
            } else {
                console.log(err);
                callback(err);
            }
        });
    });
}

// Gets stored information about a group
exports.getGroupInfo = (threadId, callback) => {
    exports.getGroupData((err, groupData) => {
        if (err) {
            // Error retrieving data
            callback(err);
        } else {
            // No errors and groups are retrieved
            const group = groupData[threadId];
            if (group) {
                callback(null, group);
            } else {
                // No errors, but group not in list; pass null for both
                callback();
            }
        }
    });
}

// Wrapper function for retrieving all groups from memory
exports.getGroupData = (callback) => {
    mem.get(`groups`, (err, groups) => {
        if (err) {
            // Error retrieving data
            callback(err);
        } else {
            // No errors and groups are retrieved
            const groupData = (groups && groups.length) ? JSON.parse(groups) : {};
            callback(null, groupData);
        }
    });
}

// Updates stored information about a group
exports.setGroupInfo = (info, callback = () => { }) => {
    exports.getGroupData((err, groupData) => {
        if (!err) {
            groupData[info.threadId] = info;
            mem.set(`groups`, JSON.stringify(groupData), {}, (err, success) => {
                callback(success ? null : err);
            });
        }
    });
}

// Wrapper for updating a group property
exports.setGroupProperty = (key, value, info, callback = () => { }) => {
    if (!lockedThreads.includes(info.threadId)) {
        info[key] = value;
        lockedThreads.push(info.threadId);
        setTimeout(() => {
            exports.setGroupInfo(info, (err) => {
                lockedThreads = lockedThreads.filter(t => t != info.threadId);
                callback(err);
            });
        }, 1500);
    }
    // NOTE: temporary arbitrary delay until I can figure out how to prevent
    // the background update calls from overwriting these property changes (async/await?)
}

// Searches help for a given entry and returns an object containing the entry
// and its key if found
exports.getHelpEntry = (input) => {
    const co = commands.commands;
    for (let c in co) {
        if (co.hasOwnProperty(c)) {
            const names = co[c].display_names;
            for (let i = 0; i < names.length; i++) {
                if (input == names[i]) {
                    return {
                        "key": c,
                        "entry": co[c]
                    };
                }
            }
        }
    }
}
// Searches help for a given category and returns an object containing the
// entry and its key if found
exports.getHelpCategory = (input) => {
    const cat = commands.categories;
    for (let c in cat) {
        if (cat.hasOwnProperty(c)) {
            const catEntry = cat[c];
            if (catEntry.display_name && input == cat[c].display_name.toLowerCase()) {
                return catEntry;
            }
        }
    }
}

// Wrapper for sending an emoji to the group quickly
exports.sendGroupEmoji = (groupInfo, size = "medium") => {
    exports.sendEmoji(groupInfo.emoji || config.defaultEmoji, groupInfo.threadId, size);
}

// Specify size as a string: "small", "medium", or "large"
exports.sendEmoji = (emoji, threadId, size = "small") => {
    exports.sendMessage({
        "emoji": emoji,
        "emojiSize": size
    }, threadId);
}

exports.isBanned = (senderId, groupInfo) => {
    return (config.banned.indexOf(senderId) > -1 || !senderId || !groupInfo.names[senderId]);
}

// Sends file(s) where each filename is a relative path to the file from root
// Accepts a string filename or an array of filename strings, and optional
// message body parameter, callback, and a message ID (for replying)
exports.sendFile = (filenames, threadId, message = "", callback = () => { }, replyId = null, api = gapi) => {
    if (typeof (filenames) == "string") { // If only one is passed
        filenames = [filenames];
    }
    for (let i = 0; i < filenames.length; i++) {
        filenames[i] = fs.createReadStream(`${__dirname}/${filenames[i]}`);
    }
    const msg = {
        "body": message,
        "attachment": filenames
    }
    exports.sendMessage(msg, threadId, callback, replyId);
}

// Returns a string of the current time in EST
exports.getTimeString = () => {
    const d = new Date();
    return d.toLocaleTimeString('en-US', { 'timeZone': config.timeZone });
}

// Wrapper for formatted date at current time
exports.getDateString = () => {
    return (new Date()).toLocaleDateString();
}

// Given a date, return a nicely-formatted string (with time)
exports.getPrettyDateString = (date) => {
    const options = {
        'weekday': 'long',
        'year': 'numeric',
        'month': 'long',
        'day': 'numeric',
        'hour': 'numeric',
        'minute': 'numeric',
        'timeZone': config.timeZone,
        'hour12': true
    };

    return date.toLocaleString('en-US', options)
}

/*
Creates a description for a user search result given the match's data from the chat API
Also performs a Graph API search for a high-res version of the user's profile picture
and uploads it with the description if it finds one
Optional parameter to specify which level of match it is (1st, 2nd, 3rd, etc.)
*/
exports.searchForUser = (match, threadId, num = 0, api = gapi) => {
    const desc = `${(num === 0) ? "Best match" : "Match " + (num + 1)}: ${match.name}\n${match.profileUrl}\nRank: ${match.score}`;

    // Try to get large propic URL from Facebook Graph API using user ID
    // If propic exists, combine it with the description
    const userId = match.userID;
    const graphUrl = `https://graph.facebook.com/${userId}/picture?type=large&redirect=false&width=400&height=400`;
    request.get(graphUrl, (err, res, body) => {
        if (res.statusCode == 200) {
            const url = JSON.parse(body).data.url; // Photo URL from Graph API
            const photoUrl = `../media/profiles/${userId}.jpg`; // Location of downloaded file
            if (url) {
                exports.sendFileFromUrl(url, photoUrl, desc, threadId);
            } else {
                exports.sendMessage(desc, threadId);
            }
        }
    });
}

/*
Sends a file to the group from a URL by temporarily downloading it
and re-uploading it as part of the message (useful for images on Facebook
domains, which are blocked by Facebook for URL auto-detection)
Accepts url, optional file download location/name, optional message, and optional
threadId parameters
*/
exports.sendFileFromUrl = (url, path = "../media/temp.jpg", message = "", threadId, api = gapi) => {
    request.head(url, (err, res, body) => {
        // Download file and pass to chat API
        const fullpath = `${__dirname}/${path}`;
        if (!err) {
            request(url).pipe(fs.createWriteStream(fullpath)).on('close', (err, data) => {
                if (!err) {
                    // Use API's official sendMessage here for callback functionality
                    exports.sendMessage({
                        "body": message,
                        "attachment": fs.createReadStream(fullpath)
                    }, threadId, (err, data) => {
                        // Delete downloaded propic
                        fs.unlink(fullpath);
                    });
                } else {
                    exports.sendMessage(message, threadId);
                }
            });
        } else {
            // Just send the description if photo can't be downloaded
            exports.sendMessage(message, threadId);
        }
    });
}

// Gets a random hex color from the list of supported values (now that Facebook has restricted it to
// a certain subset of them; more specifically, the lowercase hex values of colors in the palette UI)
exports.getRandomColor = (api = gapi) => {
    const colors = Object.keys(api.threadColors).map(n => api.threadColors[n]);
    return colors[Math.floor(Math.random() * colors.length)];
}

// Restarts the bot (requires deploying to Heroku – see config)
// Includes optional callback
exports.restart = (callback = () => { }) => {
    request.delete({
        "url": `https://api.heroku.com/apps/${config.appName}/dynos/web`,
        "headers": {
            "Accept": "application/vnd.heroku+json; version=3",
            "Authorization": `Bearer ${credentials.TOKEN}` // Requires Heroku OAuth token for authorization
        }
    });
    callback();
}

// Constructs a string of artists when passed a track object from the Spotify API
exports.getArtists = (track) => {
    const artists = track.artists;
    artistStr = "";
    for (let i = 0; i < artists.length; i++) {
        artistStr += artists[i].name;
        if (i != artists.length - 1) {
            artistStr += "/";
        }
    }
    return artistStr;
}

// Logs into Spotify API & sets the appropriate credentials
exports.loginSpotify = (spotify, callback = () => { }) => {
    spotify.clientCredentialsGrant({}, (err, data) => {
        if (!err) {
            spotify.setAccessToken(data.body.access_token);
            callback();
        } else {
            callback(err);
        }
    });
}

// Sends the contents of a given file (works best with text files)
exports.sendContentsOfFile = (file, threadId) => {
    fs.readFile(`${__dirname}/${file}`, "utf-8", (err, text) => {
        if (!err) {
            exports.sendMessage(text, threadId);
        } else {
            console.log(err);
        }
    });
}

// Functions for getting/setting user scores (doesn't save much in terms of
// code/DRY, but wraps the functions so that it's easy to change how they're stored)
exports.setScore = (userId, score, callback) => {
    mem.set(`userscore_${userId}`, score, {}, callback);
}

exports.getScore = (userId, callback) => {
    mem.get(`userscore_${userId}`, callback);
}

// Updates the user's score either by (if isAdd) increasing or (otherwise) decreasing
// the user's score by the default value set in config, or 5 points if not set
// Returns a callback with error, success, and a value equal to the user's new score
exports.updateScore = (isAdd, userId, callback) => {
    exports.getScore(userId, (err, val) => {
        if (err) {
            callback(err);
        }
        // Convert from buffer & grab current score (set 0 if it doesn't yet exist)
        const score = val ? parseInt(val.toString()) : 0;

        // Can be easily customized to accept a score parameter if so desired
        const points = config.votePoints || 5; // Default to five points
        const newScore = isAdd ? (score + points) : (score - points);
        exports.setScore(userId, `${newScore}`, (err, success) => {
            callback(err, success, newScore);
        });
    });
}

exports.getAllScores = (groupInfo, callback = () => { }) => {
    const members = groupInfo.names;
    let results = [];
    let now = current = (new Date()).getTime();

    function updateResults(value) {
        results.push(value);
        const success = (results.length == Object.keys(members).length);

        current = (new Date()).getTime();
        if (success || (current - now) >= config.asyncTimeout) {
            callback(success, results)
        }
    }

    for (let m in members) {
        if (members.hasOwnProperty(m)) {
            exports.getScore(m, (err, val) => {
                updateResults({
                    "name": members[m],
                    "score": parseInt(val) || "0"
                });
            });
        }
    }
}

// Sets group image to image found at given URL
// Accepts url, threadId, and optional error message parameter to be displayed if changing the group image fails
exports.setGroupImageFromUrl = (url, threadId, errMsg = "Photo couldn't download properly", api = gapi) => {
    // Download file and pass to chat API (see config for details)
    // 10 is length of rest of path string (media/.png)
    const path = `../media/${encodeURIComponent(url.substring(0, config.MAXPATH - 10))}.png`;
    const fullpath = `${__dirname}/${path}`;
    request(url).pipe(fs.createWriteStream(fullpath)).on('close', (err, data) => {
        if (!err) {
            api.changeGroupImage(fs.createReadStream(fullpath), threadId, (err) => {
                fs.unlink(fullpath);
                if (err) {
                    exports.sendError(errMsg, threadId);
                }
            });
        } else {
            exports.sendError("Image not found at that URL");
        }
    });
}

// Processes an image or images by sifting between URL input and attachments and downloading
// Returns a JIMP image object and filename where the image was stored
exports.processImage = (url, attachments, info, callback = () => { }) => {
    const threadId = info.threadId;
    if (url) { // URL passed
        const filename = `../media/${encodeURIComponent(url)}.png`;
        jimp.read(url, (err, file) => {
            if (err) {
                exports.sendError("Unable to retrieve image from that URL", threadId);
            } else {
                callback(file, filename);
            }
        });
    } else if (attachments || (info.lastMessage && info.lastMessage.attachments.length > 0)) {
        const attaches = attachments || info.lastMessage.attachments; // Either current message or last
        for (let i = 0; i < attaches.length; i++) {
            if (attaches[i].type == "photo") {
                const filename = `../media/${attaches[i].name}.png`;
                jimp.read(attaches[i].largePreviewUrl, (err, file) => {
                    if (err) {
                        exports.sendError("Invalid file", threadId);
                    } else {
                        callback(file, filename);
                    }
                });
            } else {
                exports.sendError(`Sorry, but ${attaches[i].name} is not an acceptable file type`, threadId);
            }
        }
    } else {
        exports.sendError("You must provide either a URL or a valid image attachment", threadId);
    }
}

// Gets dimensions of text for centering it on an image
exports.measureText = (font, text) => {
    let x = 0;
    let y = 0;
    for (let i = 0; i < text.length; i++) {
        if (font.chars[text[i]]) {
            x += font.chars[text[i]].xoffset +
                (font.kernings[text[i]] && font.kernings[text[i]][text[i + 1]] ? font.kernings[text[i]][text[i + 1]] : 0) +
                (font.chars[text[i]].xadvance || 0);
            const width = font.chars[text[i]].yoffset;
            if (width > y) {
                y = width;
            }
        }
    }
    return [x, y];
}

// Sends a message to all of the chats that the bot is currenty in (use sparingly)
exports.sendToAll = (msg) => {
    exports.getGroupData((err, groupData) => {
        if (!err && groupData) {
            for (let g in groupData) {
                if (groupData[g].isGroup) {
                    exports.sendMessage(msg, g);
                }
            }
        }
    });
}

// Sends all files in a directory (relative to root)
exports.sendFilesFromDir = (dir, threadId) => {
    fs.readdir(dir, (err, filenames) => {
        if (!err) {
            exports.sendFile(filenames.map((f) => {
                return `${dir}/${f}`;
            }), threadId);
        } else {
            console.log(err);
        }
    });
}

/*
Retrieve usage stats for a command from memory
Takes a command string, a fullData flag, and optional callback
The callback passes an object containing the count for that command,
the total number of commands and, if the fullData flag is true, a log of
all the command's uses with an "at" timestamp and the "user" of the invoker
for each command as an array of dictionaries with these properties
*/
exports.getStats = (command, fullData, callback) => {
    mem.get(`usage_total_${command}`, (err, count) => {
        mem.get(`usage_total_all`, (err, total) => {
            if (!err) {
                let stats = {
                    "count": (parseInt(count) || 0),
                    "total": (parseInt(total) || 0)
                };
                if (fullData) {
                    mem.get(`usage_record_${command}`, (err, record) => {
                        if (!err) {
                            stats.record = (JSON.parse(record) || []);
                            callback(null, stats);
                        } else {
                            callback(err);
                        }
                    });
                } else {
                    callback(null, stats);
                }
            } else {
                callback(err);
            }
        });
    });
}

// Updates the usage stats for a command in memory
// Takes a command string and a stats object with `count`, `total`, and
// `record` fields (i.e. the output from `getStats()` with the `fullData`
// flag set to true)
exports.setStats = (command, stats, callback = () => { }) => {
    mem.set(`usage_total_all`, `${stats.total}`, {}, (t_err, success) => {
        mem.set(`usage_total_${command}`, `${stats.count}`, {}, (c_err, success) => {
            mem.set(`usage_record_${command}`, `${JSON.stringify(stats.record)}`, {}, (u_err, success) => {
                callback(t_err, c_err, u_err);
            });
        });
    });
}

exports.getAllStats = (callback) => {
    const co = commands.commands;
    const names = Object.keys(co).filter((c) => {
        return (co[c].display_names.length > 0); // Don't show secret commands
    });
    let results = [];
    let now = current = (new Date()).getTime();

    function updateResults(value) {
        results.push(value);

        const success = (results.length == names.length);
        current = (new Date()).getTime();

        if (success || (current - now) >= config.asyncTimeout) {
            callback(success, results)
        }
    }

    for (let i = 0; i < names.length; i++) {
        let key = names[i];
        exports.getStats(key, true, (err, stats) => {
            if (!err) {
                updateResults({
                    "key": key,
                    "pretty_name": co[key].pretty_name,
                    "stats": stats
                });
            }
        });
    }
}

// Updates the usage statistics for a particular command (takes command name and
// sending user's ID)
exports.updateStats = (command, senderID, callback = () => { }) => {
    exports.getStats(command, true, (err, stats) => {
        if (!err) {
            stats.count++;
            stats.total++;
            stats.record.push({
                "at": (new Date()).toISOString(),
                "user": senderID
            });
            exports.setStats(command, stats, callback);
        } else {
            callback(err);
        }
    })
}

// Clears the stats to start over
exports.resetStats = () => {
    const co = commands.commands;
    for (let c in co) {
        if (co.hasOwnProperty(c)) {
            exports.setStats(c, {
                "count": 0,
                "total": 0,
                "record": []
            })
        }
    }
}

// Outputs the statistics data for debugging/analysis
exports.logStats = () => {
    const co = commands.commands;
    for (let c in co) {
        if (co.hasOwnProperty(c)) {
            exports.getStats(c, true, (err, stats) => {
                console.log(`${c}: ${stats.count}/${stats.total}`);
                for (let i = 0; i < stats.record.length; i++) {
                    console.log(stats.record[i]);
                }
            });
        }
    }
}

// Returns the passed list of record objects narrowed to those within the
// specified time period
exports.narrowedWithinTime = (record, marker) => {
    return record.filter((val) => {
        return (new Date(val.at) > marker);
    });
}

// Gets the most active user of a given command using its passed records
exports.getHighestUser = (record) => {
    let usageMap = {}; // Map userIDs to number of invocations
    for (let i = 0; i < record.length; i++) {
        const id = record[i].user;
        if (!usageMap[id]) {
            usageMap[id] = 0;
        }
        usageMap[id]++;
    }

    let maxNum = 0;
    let maxUser;
    for (let u in usageMap) {
        if (usageMap.hasOwnProperty(u)) {
            if (usageMap[u] > maxNum) {
                maxNum = usageMap[u];
                maxUser = u;
            }
        }
    }
    return maxUser;
}
/* Given a stats object, it adds a `usage` field containing the following:
  `perc`: Percentage of total usage
  `day`: # of times used in the last day
  `month`: # of times used in the last month
*/
exports.getComputedStats = (stats) => {
    const usage = {};
    usage.perc = (((stats.count * 1.0) / stats.total) * 100) || 0;

    // Time scopes
    const dayMarker = new Date();
    dayMarker.setDate(dayMarker.getDate() - 1); // Last day
    const monthMarker = new Date();
    monthMarker.setMonth(monthMarker.getMonth() - 1); // Last month

    const dateRecords = exports.narrowedWithinTime(stats.record, dayMarker) // All command calls within the last day
    const monthRecords = exports.narrowedWithinTime(stats.record, monthMarker) // All command calls within the last month

    usage.day = dateRecords ? dateRecords.length : 0;
    usage.month = monthRecords ? monthRecords.length : 0;

    stats.usage = usage;
    return stats;
}

// Allows the bot to react to a message given a message ID (from listen)
// Possible reactions: 'love', 'funny', 'wow', 'sad', 'angry', 'like', and 'dislike'
exports.reactToMessage = (messageId, reaction = "like", api = gapi) => {
    const reactions = {
        "love": "😍",
        "funny": "😆",
        "wow": "😮",
        "sad": "😢",
        "angry": "😠",
        "like": "👍",
        "dislike": "👎"
    };
    api.setMessageReaction(reactions[reaction], messageId);
}

/*
Parses a given message and makes the necessary shortcut replacements, which currently include
changing "me" to the current user and any aliases to the corresponding user based on the current
group.

Returns the parsed and replaced string.
*/
exports.parseNameReplacements = (message, fromUserId, groupInfo) => {
    let fixes = message;
    // "Me" -> calling user
    fixes = fixes.replace(/(^| )me(?:[^A-z0-9]|$)/i, "$1" + groupInfo.names[fromUserId].toLowerCase());
    // {alias} -> corresponding user
    for (let a in groupInfo.aliases) {
        if (groupInfo.aliases.hasOwnProperty(a)) {
            fixes = fixes.replace(new RegExp(`(^| )${groupInfo.aliases[a]}(?:[^A-z0-9]|$)`, "i"), "$1" + a);
        }
    }
    return fixes;
}

// Deletes a pinned message from the chat
exports.deletePin = (pin, groupInfo, threadId) => {
    if (pin && groupInfo.pinned[pin]) {
        delete groupInfo.pinned[pin];
        exports.setGroupProperty("pinned", groupInfo.pinned, groupInfo, err => {
            if (!err) {
                exports.sendMessage(`Successfully deleted "${pin}".`, threadId);
            } else {
                exports.sendError(`Unable to delete "${pin}".`, threadId);
            }
        });
    } else {
        exports.sendError("Please specify an existing pin to delete.", threadId);
    }
}

// Renames a pinned message from the chat
exports.renamePin = (pinArgs, groupInfo, threadId) => {
    const args = pinArgs ? pinArgs.split(" ") : [];
    if (args.length != 2) {
        exports.sendError("Please specify a valid pin to rename and new name.", threadId);
        return;
    }

    const [oldPin, newPin] = args;
    if (oldPin && newPin && groupInfo.pinned[oldPin]) {
        if (groupInfo.pinned[newPin]) {
            exports.sendMessage(`Cannot rename "${oldPin}" to "${newPin}" as it would override an existing pin.`, threadId);
        } else {
            groupInfo.pinned[newPin] = groupInfo.pinned[oldPin];
            delete groupInfo.pinned[oldPin];
            exports.setGroupProperty("pinned", groupInfo.pinned, groupInfo, err => {
                if (!err) {
                    exports.sendMessage(`Successfully renamed "${oldPin}" to "${newPin}".`, threadId);
                } else {
                    exports.sendError(`Unable to rename "${oldPin}".`, threadId);
                }
            });
        }
    } else {
        exports.sendError("Please specify an existing pin to rename.", threadId);
    }
}

// Adds a pinned message to the chat
exports.addPin = (msg, pinName, sender, groupInfo) => {
    const pin = `"${msg}" – ${sender} on ${exports.getDateString()}`;
    const oldPin = groupInfo.pinned[pinName];
    groupInfo.pinned[pinName] = pin;
    exports.setGroupProperty("pinned", groupInfo.pinned, groupInfo, err => {
        if (!err) {
            exports.sendMessage(`Pinned new message for pin "${pinName}" to the chat.${oldPin ? `Previous message:\n\n${oldPin}` : ""}`, groupInfo.threadId);
        } else {
            exports.sendError("Unable to pin message to the chat.", threadId);
        }
    });
}

// Adds an event to the chat
exports.addEvent = (title, at, sender, groupInfo, threadId) => {
    const keyTitle = title.trim().toLowerCase();
    if (groupInfo.events[keyTitle]) {
        exports.sendError(`An event already exists called "${title}". Please delete it if you wish to make a new one.`, threadId);
        return;
    }

    const now = new Date();
    const timestamp = chrono.parseDate(at, now, { 'forwardDate': true });
    if (timestamp) {
        const prettyTime = exports.getPrettyDateString(timestamp);
        let msg = `
Event "${title}" created for ${prettyTime}. To RSVP, upvote or downvote this message. \
To delete this event, use "${config.trigger} event delete ${title}" (only the owner can do this). \
\n\nI'll remind you at the time of the event`;

        let earlyReminderTime = new Date(timestamp.getTime() - (config.reminderTime * 60000));
        if (earlyReminderTime <= now) {
            // Too late to give an early reminder
            earlyReminderTime = null;
            msg += ".";
        } else {
            msg += `, and ${config.reminderTime} minutes early.`
        }

        exports.sendMessage(msg, threadId, (err, mid) => {
            // Grab mid from sent message to monitor messages for RSVPs
            if (!err) {
                const event = {
                    "type": "event",
                    "title": title,
                    "key_title": keyTitle,
                    "timestamp": timestamp.getTime(),
                    "owner": sender,
                    "threadId": threadId,
                    "pretty_time": prettyTime,
                    "remind_time": earlyReminderTime,
                    "mid": mid.messageID,
                    "going": [],
                    "not_going": []
                }

                groupInfo.events[keyTitle] = event;
                exports.setGroupProperty("events", groupInfo.events, groupInfo);
            }
        });
    } else {
        exports.sendError("Couldn't understand that event's time.", threadId);
    }
}

// Delete an event from the chat
exports.deleteEvent = (keyTitle, sender, groupInfo, threadId, sendConfirmation = true) => {
    if (groupInfo.events[keyTitle]) {
        const event = groupInfo.events[keyTitle];
        if (event.owner == sender) {
            delete groupInfo.events[keyTitle]
            exports.setGroupProperty("events", groupInfo.events, groupInfo, err => {
                if (err) {
                    exports.sendError("Sorry, couldn't delete the event.", threadId);
                } else if (sendConfirmation) {
                    exports.sendMessage(`Successfully deleted "${event.title}".`, threadId);
                }
            });
        } else {
            exports.sendError(`Sorry, you are not the owner of this event.`, threadId);
        }
    } else {
        exports.sendError(`Couldn't find an event called ${rawTitle}.`, threadId);
    }
}

// List event(s) in the chat
exports.listEvents = (rawTitle, groupInfo, threadId) => {
    if (rawTitle) {
        // Details for specific event
        const keyTitle = rawTitle.trim().toLowerCase();
        const event = groupInfo.events[keyTitle];
        if (event) {
            const goList = event.going.map(u => u.name);
            const notGoList = event.not_going.map(u => u.name);
            let msg = `*${event.title}*\n_${event.pretty_time}_\n`;
            if (goList.length > 0) {
                msg += `Going: ${goList.join('/')}\n`;
            }
            if (notGoList.length > 0) {
                msg += `Not going: ${notGoList.join('/')}\n`;
            }
            msg += "\nTo RSVP, upvote or downvote the original event message linked above.";
            exports.sendMessage(msg, threadId, () => { }, event.mid);
        } else {
            exports.sendError(`Couldn't find an event called ${rawTitle}.`, threadId);
        }
    } else {
        // Overview
        const events = Object.keys(groupInfo.events).reduce((evts, e) => {
            const event = groupInfo.events[e];
            if (event.type == "event") {
                evts[e] = groupInfo.events[e];
            }
            return evts;
        }, {});
        if (Object.keys(events).length > 0) {
            let msg = "Events for this group: \n"
            for (const e in events) {
                if (events.hasOwnProperty(e)) {
                    const event = events[e];

                    msg += `\n– ${event.title}`
                    if (event.going.length > 0) {
                        msg += ` (${event.going.length} going)`;
                    }
                    msg += `: ${event.pretty_time}`;
                }
            }
            exports.sendMessage(msg, threadId);
        } else {
            exports.sendMessage("There are no events set in this chat.", threadId);
        }
    }
}

// Add a reminder to the chat
exports.addReminder = (userId, reminderStr, timeStr, groupInfo, threadId) => {
    gapi.getUserInfo(userId, (err, uinfo) => {
        if (!err && uinfo[userId]) {
            const timestamp = chrono.parseDate(timeStr, new Date(), { 'forwardDate': true });
            if (timestamp) {
                const time = timestamp.getTime();
                const prettyTime = exports.getPrettyDateString(timestamp);
                const keyTitle = `r${userId}_${threadId}_${time}`; // Attempt to create a unique key
                const userName = uinfo[userId].firstName;

                const reminder = {
                    "type": "reminder",
                    "reminder": reminderStr,
                    "key_title": keyTitle,
                    "timestamp": time,
                    "owner": userId,
                    "owner_name": userName,
                    "threadId": threadId
                }

                groupInfo.events[keyTitle] = reminder;
                exports.setGroupProperty("events", groupInfo.events, groupInfo, err => {
                    if (!err) {
                        exports.sendMessage(`Created a reminder for ${groupInfo.names[userId]} for ${prettyTime}.`, threadId);
                    } else {
                        exports.sendMessage("Unable to create the reminder. Please try again.", threadId);
                    }
                });
            } else {
                exports.sendError("Couldn't understand that reminder's time.", threadId);
            }
        } else {
            exports.sendError("Couldn't get that user's info.", threadId);
        }
    });
}

// Get information about current status of COVID-19
exports.getCovidData = (rawType, rawQuery, threadId) => {
    function buildMessage(data, useDetailedData) {
        let msg = `Active cases: ${data.active}\nCases today: ${data.todayCases}`;
        if (useDetailedData) {
            msg += `\nCritical cases: ${data.critical}\nCurrent cases per million: ${data.casesPerOneMillion}`;
        }

        const inferRecov = (data.cases - data.active - data.deaths);
        const recovered = data.recovered ? `Recovered: ${data.recovered}` : `${inferRecov > -1 ? `Recovered: ${inferRecov} (inferred)` : ""}`;
        msg += `\nTotal cases: ${data.cases}\n\nDeaths today: ${data.todayDeaths}\nTotal deaths: ${data.deaths}\n${recovered}`;

        if (useDetailedData) {
            msg += `\nDeaths per million: ${data.deathsPerOneMillion}`
        }

        return msg;
    }

    if (!rawType) {
        // Display total stats
        request.get("https://corona.lmao.ninja/all", {}, (err, _, all) => {
            if (!err) {
                const data = JSON.parse(all);
                const updated = exports.getPrettyDateString(new Date(data.updated));
                exports.sendMessage(`Cases: ${data.cases}\nDeaths: ${data.deaths}\nRecovered: ${data.recovered}\n\n_Last updated: ${updated}_`, threadId);
            } else {
                exports.sendError("Couldn't retrieve data.", threadId);
            }
        });
    } else {
        const type = rawType.trim().toLowerCase();
        const query = rawQuery.trim().toLowerCase();
        if (type == "country") {
            request.get(`https://corona.lmao.ninja/countries/${encodeURIComponent(query)}`, {}, (err, res, info) => {
                if (!err && res.statusCode == 200 && info != "Country not found") {
                    const data = JSON.parse(info);
                    exports.sendMessage(`*${data.country}*\n\n${buildMessage(data, true)}`, threadId);
                } else {
                    request.get(`https://corona.lmao.ninja/countries/`, {}, (err, res, info) => {
                        if (!err && res.statusCode == 200) {
                            const data = JSON.parse(info);
                            const countries = data.map(country => country.country).join(", ");
                            exports.sendMessage(`Couldn't find data for ${rawQuery}. Here are the countries I have available:\n\n${countries}`, threadId);
                        } else {
                            exports.sendError("Couldn't retrieve data.", threadId);
                        }
                    });
                }
            });
        } else if (type == "state") {
            request.get(`https://corona.lmao.ninja/states/`, {}, (err, res, info) => {
                if (!err && res.statusCode == 200) {
                    const data = JSON.parse(info);
                    const state = data.find(state => state.state.toLowerCase() == query);

                    if (state) {
                        exports.sendMessage(`*${state.state}*\n\n${buildMessage(state, false)}`, threadId);
                    } else {
                        const states = data.map(state => state.state).join(", ");
                        exports.sendMessage(`Couldn't find data for ${rawQuery}. Here are the states I have available:\n\n${states}`, threadId);
                    }
                } else {
                    exports.sendError("Couldn't retrieve data.", threadId);
                }
            });
        } else if (type == "province") {
            function reportData(region, deaths, recovered) {
                let msg = "";
                const dates = Object.keys(region).map(key => new Date(key)).filter(date => date != "Invalid Date").sort((a, b) => b - a);
                if (dates.length > 0) {
                    const recent = dates[0];
                    const recentKey = `${recent.getMonth() + 1}/${recent.getDate()}/${`${recent.getFullYear()}`.slice(-2)}`;
                    const confirmed = region[recentKey];
                    if (confirmed > 0) {
                        const regDeaths = deaths.find(reg => reg.country_Region == region.country_Region
                            && reg.province_State == region.province_State);
                        const regRec = recovered.find(reg => reg.country_Region == region.country_Region
                            && reg.province_State == region.province_State);
                        const name = region.province_State || region.country_Region;
                        msg += `\n${name}: ${confirmed} confirmed, ${regDeaths[recentKey]} dead, ${regRec[recentKey]} recovered`;
                    }
                }
                return msg;
            }

            request.get("https://api.opencovid19.com/v1/confirmed", null, (cerr, cres, casesData) => {
                request.get("https://api.opencovid19.com/v1/deaths", null, (derr, dres, deathsData) => {
                    request.get("https://api.opencovid19.com/v1/recovered", null, (rerr, rres, recoveredData) => {
                        if (!cerr && cres.statusCode == 200 && !derr && dres.statusCode == 200 && !rerr && rres.statusCode == 200) {
                            const cases = JSON.parse(casesData);
                            const deaths = JSON.parse(deathsData);
                            const recovered = JSON.parse(recoveredData);

                            const province = cases.find(region => region.province_State && region.province_State.toLowerCase() == query);
                            if (province) {
                                exports.sendMessage(reportData(province, deaths, recovered), threadId);
                            } else {
                                exports.sendError(`There is no data currently being reported for ${rawQuery}.`, threadId);
                            }
                        } else {
                            exports.sendError("Couldn't retrieve data.", threadId);
                        }
                    });
                });
            });
        }
    }
}