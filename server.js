const express = require('express');
const cors = require('cors');
const { ApolloServer } = require('apollo-server-express');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const { useServer } = require('graphql-ws/lib/use/ws');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const connectDB = require('./db/db');
const context = require('./context/context');
const generateToken = require('./config/generateToken');
const { PubSub } = require('graphql-subscriptions');
require('dotenv').config();

const User = require('./models/user.model');
const Chat = require('./models/chat.model');
const Message = require('./models/message.model');

const app = express();
app.use(express.json());
app.use(cors());
const PORT = process.env.PORT;
connectDB();
const pubsub = new PubSub();

const typeDefs = `
    type User {
        _id: ID!
        userName: String!
        email: String!
        password: String!
        pic: String
        isAdmin: Boolean
    }
    type Chat {
        _id: ID!
        chatName: String
        isGroupChat: Boolean!
        latestMessage: Message
        users: [User]
        groupAdmins: [User]
        updatedAt: String
    }
    type Message {
        _id: ID!
        sender: User
        content: String
        chat: Chat
    }
    type Query {
        searchUsers(search: String): [User]
        singleChat(userID: String): Chat
        fetchChats: [Chat]
        fetchSingleChatMessages(chatId: ID!): [Message]
    }
    type Mutation {
        signup(userName: String!, email: String!, password: String!): AuthResponse
        login(email: String!, password: String!): AuthResponse
        createGroupChat(chatName: String, users: [ID!]): Chat
        renameGroup(chatName: String, chatId: ID!): Chat
        removeFromGroup(chatId: ID!, userId: ID!): Chat
        deleteGroup(chatId: ID!): DeleteResponse
        makeGroupAdmin(chatId: ID!, userId: ID!): Chat
        sendMessage(chatId: ID!, content: String!): Message
        addMemberToGroup(userId: ID!, chatId: ID!): Chat
    }
    type Subscription {
        messageAdded(chatId: ID!): Message
    }
    type AuthResponse {
        user: User
        token: String
    }
    type DeleteResponse {
        message: String
        deletedChat: Chat
    }
`;

const resolvers = {
    Query: {
        searchUsers: async (_, { search }, { user }) => {
            if (!user) {
                console.log('User is not authenticated');
                throw new Error('Not authenticated');
            }

            const keyword = search ? {
                $or: [
                    { userName: { $regex: search, $options: "i" } },
                    { email: { $regex: search, $options: "i" } }
                ]
            } : {};

            try {
                const searchedUsers = await User.find(keyword).find({ _id: { $ne: user._id } });
                return searchedUsers;
            } catch (error) {
                console.error('Failed to fetch users:', error);
                throw new Error('Failed to fetch users');
            }
        },
        singleChat: async (_, { userID }, { user }) => {
            if (!user) {
                console.log('User is not authenticated');
                throw new Error('Not authenticated');
            }

            try {
                let chat = await Chat.findOne({
                    isGroupChat: false,
                    users: { $all: [user._id, userID] }
                })
                    .populate('users', '-password')
                    .populate({
                        path: 'latestMessage',
                        populate: { path: 'sender', select: 'userName email pic' }
                    });

                if (!chat) {
                    const newChat = await Chat.create({
                        chatName: "Sender",
                        isGroupChat: false,
                        users: [user._id, userID]
                    });

                    chat = await Chat.findById(newChat._id)
                        .populate('users', '-password')
                        .populate({
                            path: 'latestMessage',
                            populate: { path: 'sender', select: 'userName email pic' }
                        });
                }

                return chat;
            } catch (error) {
                console.error('Failed to fetch or create single chat:', error);
                throw new Error('Failed to fetch or create single chat');
            }
        },
        fetchChats: async (_, __, { user }) => {
            if (!user) {
                console.log('User is not authenticated');
                throw new Error('Not authenticated');
            }

            try {
                let results = await Chat.find({ users: { $elemMatch: { $eq: user._id } } })
                    .populate("users", "-password")
                    .populate("groupAdmins", "-password")
                    .populate("latestMessage")
                    .sort({ updatedAt: -1 });

                results = await User.populate(results, {
                    path: "latestMessage.sender",
                    select: "userName pic email",
                });

                return results;
            } catch (error) {
                console.error('Failed to fetch chats:', error);
                throw new Error('Failed to fetch chats');
            }
        },
        fetchSingleChatMessages: async (_, { chatId }, { user }) => {
            if (!user) {
                console.log('User is not authenticated');
                throw new Error('Not authenticated');
            }
            try {
                const message = await Message.find({ chat: chatId })
                    .populate("sender", "userName pic email")
                    .populate({
                        path: "chat",
                        populate: {
                            path: 'users',
                            select: 'userName pic email'
                        }
                    });

                return message;
            } catch (error) {
                if (error) {
                    throw new Error(error);
                }
            }
        }
    },
    Mutation: {
        signup: async (_, { userName, email, password }) => {
            const existingUser = await User.findOne({ email });

            if (existingUser) {
                throw new Error("User already exists");
            }

            const newUser = await User.create({
                userName,
                email,
                password
            });

            return {
                user: newUser,
            };
        },
        login: async (_, { email, password }) => {
            const existingUser = await User.findOne({ email });

            if (!existingUser) {
                throw new Error('Invalid email or password');
            }
            if (existingUser.password !== password) {
                throw new Error('Password is incorrect');
            }
            const token = generateToken(existingUser);

            return {
                user: existingUser,
                token
            };
        },
        createGroupChat: async (_, { chatName, users }, { user }) => {
            if (!user) return ('Authentication required');

            if (users.length < 2) {
                throw new Error('More than 2 users are required to make a group');
            }

            users.push(user);
            const groupChat = await Chat.create({
                chatName,
                isGroupChat: true,
                groupAdmins: [user._id],
                users
            });

            return await Chat.findOne({ _id: groupChat._id })
                .populate("users", "-password")
                .populate("groupAdmins", "-password");
        },
        renameGroup: async (_, { chatId, chatName }, { user }) => {
            if (!user) return ('Authentication required');
            const chat = await Chat.findByIdAndUpdate(chatId, { chatName }, { new: true })
                .populate("users", "-password")
                .populate("groupAdmins", "-password")

            if (!chat) return ("No chat found");
            return chat
        },
        removeFromGroup: async (_, { chatId, userId }, { user }) => {
            if (!user) return ('Authentication required');

            try {
                const getChat = await Chat.findById(chatId);

                if (!getChat) {
                    throw new Error('Chat not found');
                }

                const isGroupAdmin = getChat.groupAdmins.some(adminId => adminId.toString() === user._id.toString());

                if (!isGroupAdmin) {
                    throw new Error("You don't have access to delete this group");
                };

                const chat = await Chat.findByIdAndUpdate(chatId, { $pull: { users: userId } }, { new: true })
                    .populate("users", "-password")
                    .populate("groupAdmins", "-password")

                return chat;
            } catch (error) {
                throw new Error(error)
            }
        },
        deleteGroup: async (_, { chatId }, { user }) => {
            if (!user) {
                throw new Error('Authentication required');
            }

            try {
                const chat = await Chat.findById(chatId);

                if (!chat) {
                    throw new Error('Chat not found');
                }

                const isGroupAdmin = chat.groupAdmins.some(adminId => adminId.toString() === user._id.toString());

                if (!isGroupAdmin) {
                    throw new Error("You don't have access to delete this group");
                }

                const deletedChat = await Chat.findByIdAndDelete(chatId);

                if (!deletedChat) {
                    throw new Error('Failed to delete chat');
                }

                console.log('Deleted chat:', deletedChat.chatName);
                return {
                    message: 'Chat deleted successfully',
                    deletedChat
                };
            } catch (error) {
                if (error.message === 'Chat not found') {
                    throw new Error('Chat not found');
                }
                console.error('Failed to delete chat:', error);
                throw new Error('Failed to delete chat');
            }
        },
        makeGroupAdmin: async (_, { chatId, userId }, { user }) => {
            if (!user) {
                throw new Error('Authentication required');
            }

            try {
                const chat = await Chat.findById(chatId);

                if (!chat) {
                    throw new Error('Chat not found');
                }

                const isGroupAdmin = chat.groupAdmins.some(adminId => adminId.toString() === user._id.toString());

                if (!isGroupAdmin) {
                    throw new Error("You don't have access to make someone a group admin");
                }

                let updatedChat = await Chat.findByIdAndUpdate(
                    chatId,
                    { $addToSet: { groupAdmins: userId } },
                    { new: true }
                );
                await updatedChat.populate("groupAdmins", "-password");
                return updatedChat;
            } catch (error) {
                throw new Error(error.message);
            }
        },
        sendMessage: async (_, { chatId, content }, { user }) => {
            if (!user) {
                console.log('User is not authenticated');
                throw new Error('Not authenticated');
            }

            if (!chatId || !content) throw new Error("ChatId or Content is missing!!");

            const newMessage = {
                sender: user._id,
                content: content,
                chat: chatId
            };

            try {
                let message = await Message.create(newMessage);
                message = await message.populate("sender", "userName pic");
                message = await message.populate("chat");
                message = await User.populate(message, {
                    path: 'chat.users',
                    select: "userName pic email",
                });

                await Chat.findByIdAndUpdate(chatId, {
                    latestMessage: message
                });

                // Publish the messageAdded event
                pubsub.publish(`MESSAGE_SENT_${chatId}`, { messageAdded: message, chatId });

                return message;
            } catch (error) {
                if (error) {
                    throw new Error(error);
                }
            }
        },
        addMemberToGroup: async (_, { userId, chatId }, { user }) => {
            if (!user) {
                console.log('User is not authenticated');
                throw new Error('Not authenticated');
            };

            if (!chatId || !userId) throw new Error("ChatId or Content is missing!!");
            try {
                const chat = await Chat.findById(chatId);
                if (!chat) {
                    throw new Error('Chat not found');
                }
                const isGroupAdmin = chat.groupAdmins.some(admin => admin.toString() === user._id.toString());
                if (!isGroupAdmin) {
                    throw new Error("Only admin can add user");
                }
                const existingUser = chat.users.some(exUser => exUser.toString() === userId.toString());
                if (!existingUser) {
                    let updatedChat = await Chat.findByIdAndUpdate(chatId, { $addToSet: { users: userId } }, { new: true });
                    await updatedChat.populate("users", "-password");
                    return updatedChat;
                } else {
                    throw new Error('User already exist int the group');
                }
            } catch (error) {
                throw new Error(error);
            }
        }
    },
    Subscription: {
        messageAdded: {
            subscribe: (_, { chatId }) => pubsub.asyncIterator(`MESSAGE_SENT_${chatId}`)
        }
    }
};

const schema = makeExecutableSchema({ typeDefs, resolvers });
const httpServer = createServer(app);

const wsServer = new WebSocketServer({
    server: httpServer,
    path: '/graphql'
});

const serverCleanup = useServer({ schema }, wsServer);

const server = new ApolloServer({
    schema,
    context
});

(async () => {
    await server.start();
    server.applyMiddleware({ app, path: '/graphql' });
    httpServer.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}/graphql`);
    });
})();