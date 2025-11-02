const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');
const Datastore = require('nedb'); // 引入NeDB

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// 初始化NeDB数据库（不用注册，直接存到项目文件）
const UserDB = new Datastore({ filename: './data/users.db', autoload: true });
const ChannelDB = new Datastore({ filename: './data/channels.db', autoload: true });
const MessageDB = new Datastore({ filename: './data/messages.db', autoload: true });

// 确保数据文件夹存在
const fs = require('fs');
if (!fs.existsSync('./data')) fs.mkdirSync('./data');

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// 注册接口
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ msg: '用户名和密码不能为空' });
    
    // 检查用户名是否已存在
    UserDB.findOne({ username }, async (err, existingUser) => {
      if (err) return res.status(500).json({ msg: '服务器错误' });
      if (existingUser) return res.status(400).json({ msg: '用户名已被使用' });
      
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);
      
      UserDB.insert({ username, password: hashedPassword }, (err) => {
        if (err) return res.status(500).json({ msg: '服务器错误' });
        res.status(201).json({ msg: '注册成功' });
      });
    });
  } catch (err) {
    res.status(500).json({ msg: '服务器错误' });
  }
});

// 登录接口
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    UserDB.findOne({ username }, async (err, user) => {
      if (err) return res.status(500).json({ msg: '服务器错误' });
      if (!user) return res.status(400).json({ msg: '用户名或密码错误' });
      
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) return res.status(400).json({ msg: '用户名或密码错误' });
      res.json({ msg: '登录成功', username });
    });
  } catch (err) {
    res.status(500).json({ msg: '服务器错误' });
  }
});

// 获取所有频道
app.get('/api/channels', (req, res) => {
  ChannelDB.find({}).sort({ createdAt: -1 }).exec((err, channels) => {
    if (err) return res.status(500).json({ msg: '服务器错误' });
    res.json(channels);
  });
});

// 获取用户已加入的频道
app.post('/api/user-channels', (req, res) => {
  const { username } = req.body;
  ChannelDB.find({ members: username }).sort({ createdAt: -1 }).exec((err, channels) => {
    if (err) return res.status(500).json({ msg: '服务器错误' });
    res.json(channels);
  });
});

// 频道管理接口
app.post('/api/manage-channel', (req, res) => {
  const { channelId, creator, action, newName, newPassword, targetUser } = req.body;
  
  ChannelDB.findOne({ _id: channelId }, (err, channel) => {
    if (err) return res.status(500).json({ msg: '服务器错误' });
    if (!channel) return res.status(400).json({ msg: '频道不存在' });
    if (channel.creator !== creator) return res.status(403).json({ msg: '你不是频道创建者' });

    switch (action) {
      case 'rename': channel.name = newName; break;
      case 'changePassword': channel.password = newPassword; break;
      case 'mute': if (!channel.mutedUsers.includes(targetUser)) channel.mutedUsers.push(targetUser); break;
      case 'unmute': channel.mutedUsers = channel.mutedUsers.filter(u => u !== targetUser); break;
      case 'ban': 
        channel.bannedUsers.push(targetUser);
        channel.members = channel.members.filter(u => u !== targetUser);
        break;
      case 'unban': channel.bannedUsers = channel.bannedUsers.filter(u => u !== targetUser); break;
      case 'clearChat': MessageDB.remove({ channelId }, { multi: true }, () => {}); break;
      case 'dissolve': 
        MessageDB.remove({ channelId }, { multi: true }, () => {});
        ChannelDB.remove({ _id: channelId }, {}, (err) => {
          if (err) return res.status(500).json({ msg: '服务器错误' });
          io.emit('channel-dissolved', channelId);
          return res.json({ msg: '频道已解散' });
        });
        return;
      default: return res.status(400).json({ msg: '无效操作' });
    }

    ChannelDB.update({ _id: channelId }, channel, (err) => {
      if (err) return res.status(500).json({ msg: '服务器错误' });
      io.emit('channel-updated', channel);
      res.json({ msg: '操作成功' });
    });
  });
});

// Socket.io实时聊天（功能不变）
io.on('connection', (socket) => {
  console.log('用户连接:', socket.id);

  // 加入公共聊天室
  socket.on('join-public', (username) => {
    socket.join('public-chat');
    socket.emit('join-success', '已加入公共聊天室');
  });

  // 发送公共消息
  socket.on('public-message', (data) => {
    const { username, content } = data;
    const msgData = { username, content, timestamp: new Date().toLocaleString() };
    io.to('public-chat').emit('new-public-message', msgData);
    MessageDB.insert({ channelId: 'public-chat', username, content, timestamp: new Date() });
  });

  // 创建私人频道
  socket.on('create-channel', (data) => {
    const { name, password, creator } = data;
    const channel = {
      _id: Date.now().toString(), // 用时间戳当ID
      name,
      creator,
      password,
      members: [creator],
      mutedUsers: [],
      bannedUsers: [],
      createdAt: new Date()
    };
    ChannelDB.insert(channel, (err) => {
      if (err) return socket.emit('create-fail', '创建频道失败');
      io.emit('channel-created', channel);
      socket.join(channel._id);
      socket.emit('create-success', { channelId: channel._id, msg: '频道创建成功' });
    });
  });

  // 加入私人频道
  socket.on('join-channel', (data) => {
    const { channelId, username, password } = data;
    ChannelDB.findOne({ _id: channelId }, (err, channel) => {
      if (err) return socket.emit('join-fail', '加入失败');
      if (!channel) return socket.emit('join-fail', '频道不存在');
      if (channel.bannedUsers.includes(username)) return socket.emit('join-fail', '你已被封禁');
      if (channel.password && channel.password !== password) return socket.emit('join-fail', '密码错误');
      
      if (!channel.members.includes(username)) {
        channel.members.push(username);
        ChannelDB.update({ _id: channelId }, channel, () => {});
      }
      
      socket.join(channelId);
      MessageDB.find({ channelId }).sort({ timestamp: 1 }).exec((err, messages) => {
        const msgList = messages.map(msg => ({
          username: msg.username,
          content: msg.content,
          timestamp: new Date(msg.timestamp).toLocaleString()
        }));
        socket.emit('join-success', { channel, messages: msgList });
        socket.to(channelId).emit('member-joined', username);
      });
    });
  });

  // 发送私人频道消息
  socket.on('channel-message', (data) => {
    const { channelId, username, content } = data;
    ChannelDB.findOne({ _id: channelId }, (err, channel) => {
      if (err || !channel) return;
      if (channel.mutedUsers.includes(username)) return socket.emit('message-fail', '你已被禁言');
      
      const msgData = {
        username,
        content,
        timestamp: new Date().toLocaleString()
      };
      io.to(channelId).emit('new-channel-message', msgData);
      MessageDB.insert({ channelId, username, content, timestamp: new Date() });
    });
  });

  socket.on('disconnect', () => {
    console.log('用户断开连接:', socket.id);
  });
});

// 启动服务
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务启动成功，端口：${PORT}`);
});
