const discord = require('discord.js');
const fs = require('fs');
const aws = require('aws-sdk');
const uuid = require('uuid-random');
const https = require('https');
const spawn = require('child_process').spawn;
var settings = JSON.parse(fs.readFileSync('config.json', 'utf8'));
var client = new discord.Client();
var emojis = JSON.parse(fs.readFileSync('emojis.json', 'utf8'));
var s3 = new aws.S3({
  accessKeyId: settings.aws.key,
  secretAccessKey: settings.aws.secret,
  region: settings.aws.region
});
aws.config.loadFromPath('aws.json');
// Missing region workaround
aws.config.update({
  region: settings.aws.region
});

client.on('guildCreate', guild => {
  // Joined new guild
  lg("Joined new server: " + guild.name)
  setupServer(guild);
});

client.on('guildDelete', guild => {
  // Removed from guild
  lg("Removed from " + guild.name);
});


client.on('ready', () => {
  lg('Logged in as ' + client.user.tag);
  // Spin up web server for serving up faces
  //spawnServer();
  // cache messages + make sure emojis exist
  client.guilds.cache.forEach((server) => {
    lg(server.name);
    // Check Emojis
    setupServer(server);
  });
});

client.on('messageReactionAdd', (msg, user) => {
  // If AWS emoji was set, run image through AI
  switch(msg.emoji.name){
    case "faceai":
      // Run through Rekognitian Face AI
      msg.message.attachments.forEach((attachment) => {
        var filename = attachment.name.toLowerCase();
        if(attachment.size <= 5000000 && (filename.includes('jpg') || filename.includes('png') || filename.includes('jpeg'))){
          // attachment small enough and a valid format to pass to AI
          var extension = '.jpg';
          if(filename.includes('png')){
            extension = '.png';
          }
          
          // var response = getGender(attachment.url, extension);
          handleFace(msg, attachment.url, extension, attachment);
          // if(response != -1 || response != 0){
          //   // recieved specs
          //   console.dir({resp: response}, {depth: null, colors: true});
          // }else{
          //   msg.message.reply('Unable to process image');
          // }
          // msg.message.reply(JSON.stringify(response, getCircularReplacer()));
        }
      });
      break;
    case 'brass':
      // Testing Reaction...
      msg.message.channel.send('This is an embed', {
        embed: {
          thumbnail: {
               url: 'attachment://file.png'
            }
         },
         files: [{
            attachment: './emojis/face.png',
            name: 'file.png'
         }]
      }).catch(console.error);
      break;
    default:
      // Run no processing
      break;
  }
});

client.on('message', (msg) => {
  if(msg.content.includes("faceai")){
    // Face AI command found...
    // if(msg.content.includes("quota")){
    //   // Print AI quota usage for the month
    //   msg.channel.send({
    //     embed: {
    //       description: 'AI Quota:\nI don\'t fucking know....',
    //       author: {
    //         name: msg.message.author.username,
    //         icon_url: msg.message.author.avatarURL
    //       }
    //     }
    //   });
    // }
  }
});

client.login(settings.discord);

function setupServer(server){
  var serverEmojis = server.emojis;
  emojis.list.forEach((e) => {
    // For each emoji that should be there...
    var emojiFound = false;
    serverEmojis.cache.forEach((serverEmoji) => {
      //lg(serverEmoji.name);
      if(serverEmoji.name == e.name){
        // Emoji found, move on
        emojiFound = true;
        lg('Found ' + e.name);
      }
    });
    if(!emojiFound){
      // Emoji missing, add....
      server.emojis.create(emojis.cdn+e.path, e.name)
        .then(emoji => lg(`Emoji: ${emoji.name} on ${server.name}`))
        .catch(console.error);
    }
  });
  // Load Cache to watch images
  server.channels.cache.forEach((channel) =>{
    //channel.messages. fetch();
    // TODO: fix because it's not caching the latest images on a server
    if(typeof channel.messages !== 'undefined'){
      // channel.messages.size; // 3
      channel.messages.fetch({ limit: 100 }).then((fetchedChannel) => {
        // lg(fetchedChannel.messages.size); // 90
        lg();
      });
    }
  });
}

function handleFace(msg, link, extension, att){
  // Upload URL to S3 and pass into Rekognition
  var s3Params = {
    Bucket: settings.aws.bucket,
    Key: uuid()+extension
  }
  lg('down');
  const buff = fs.createWriteStream(s3Params.Key);
  const req = https.get(link, (res) => {
    res.pipe(buff);
    res.on('end', () => {
      if(!res.complete){
        lg('download failed');
        return -1;
      }
      s3Params.Body = fs.readFileSync(s3Params.Key);
      s3.upload(s3Params, (err, data) => {
        if(err){
          lg('S3: '+err);
        }
        lg('uploaded to s3 ' + s3Params.Key);
        fs.unlink(s3Params.Key, (err)=>{
          lg(err);
        });
        var aiParams = {
          Image: {
            S3Object: {
              Bucket: settings.aws.bucket,
              Name: s3Params.Key
            }
          },
          Attributes: ['ALL']
        };
        var rek = new aws.Rekognition();
        rek.detectFaces(aiParams, (err, resp) => {
          if(err){
            lg('Face:'+err);
            return -1;
          }
          // Face detected!!!
          if(typeof resp.FaceDetails !== 'undefined'){
            // Data available...
            var person = 1;
            resp.FaceDetails.forEach((face) => {
              if (person == 16){
                msg.message.channel.send({
                  embed: {
                    description: 'Gender scan limit reached!\nMax of 15 faces per photo.',
                    author: {
                      name: msg.message.author.username,
                      icon_url: msg.message.author.avatarURL
                    }
                  }
                });
                person++;
              }else if(person > 16){
                person++;
              }else{
                var personMsg = 'Person ' + person + ':\n ';
                if(resp.FaceDetails.length == 1){
                  personMsg = '';
                }
                // Send embed message
                // TODO: issue here with rotated images
                
                var mysteryID = att.url;
                mysteryID = mysteryID.match(/\/[0-9]{18}\/([0-9]{18})\//)[1];
                var iconUrl = 'https://image.cray.lgbt/image.php/?guild='+msg.message.channel.id;
                iconUrl += "&message="+mysteryID+"&filename="+att.name+"&X="+face.BoundingBox.Left;
                iconUrl +="&Y="+face.BoundingBox.Top+"&W="+face.BoundingBox.Width+"&H="+face.BoundingBox.Height;
                lg(iconUrl);
                msg.message.channel.send({
                  embed: {
                    description: 'Gender: ' + face.Gender.Value,
                    color: settings.color[face.Gender.Value],
                    thumbnail: {
                      url: iconUrl
                    },
                    author: {
                      name: msg.message.author.username,
                      icon_url: msg.message.author.avatarURL
                    },
                    title: "Face URL",
                    url: iconUrl
                  }
                });
                person++;
                // TODO: avatarURL isn't wokring
              }
            });
          }else{
            fs.writeFileSync(s3Params.Key+'.json', JSON.stringify(resp.FaceDetails, getCircularReplacer()), (err) => {
              lg(err);
            });
            msg.message.channel.send({
              content: "Something odd happened, so here's the result...",
              files: [
                {
                  attachment: './'+s3Params.Key+'.json',
                  name: s3Params.Key+'.json'
                }
              ]
            }).catch(console.error);
          }
        });
      });
      return 0;
    });
  });
}

async function spawnServer(){
  spawn('python3', ['-m', 'http.server', '--directory', __dirname+'/faces/', settings.http.port]);
}

function saveObj(nm, oo){
  try {
    fs.writeFileSync(nm, JSON.stringify(oo, getCircularReplacer()))
  } catch( e) {
    lg(e);
  }
  
}

const getCircularReplacer = () => {
  const seen = new WeakSet();
  return (key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return;
      }
      seen.add(value);
    }
    return value;
  };
};

function lg(data){
  if(typeof data !== 'undefined' && data != null){
    if(typeof data !== 'string'){
      data = data.toString();
    }
    if(settings.logging.enabled && settings.logging.filename != ""){
      fs.appendFile(settings.logging.filename, data, function (err) {
        if (err) throw err;
      });
    }
    console.log(data);
  }else{
    // console.log();
  }
}