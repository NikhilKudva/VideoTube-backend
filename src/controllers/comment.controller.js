import { PrismaClient } from "@prisma/client";
import { ApiError } from "../utils/apiError.js";
import { ApiResponse } from "../utils/apiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import redisClient from "../config/redis.js";
import { REDIS_KEYS } from "../constants/redisKeys.js";

const prisma = new PrismaClient();
const CACHE_EXPIRATION = 60 * 60;

// Helper function to invalidate comment-related caches
const invalidateCommentCaches = async (commentId, videoId, tweetId, userId) => {
  const cachesToDelete = [];
  
  // Specific comment cache
  if (commentId) {
    cachesToDelete.push(`${REDIS_KEYS.COMMENT}${commentId}`);
    cachesToDelete.push(`${REDIS_KEYS.COMMENT_LIKES}${commentId}`);
  }
  
  // Video-related caches
  if (videoId) {
    const videoCachePattern = `${REDIS_KEYS.VIDEO_COMMENTS}${videoId}_*`;
    const videoKeys = await redisClient.keys(videoCachePattern);
    cachesToDelete.push(...videoKeys);
    
    // Invalidate video likes (as comment counts may be displayed with videos)
    cachesToDelete.push(`${REDIS_KEYS.VIDEO_LIKES}${videoId}`);
    cachesToDelete.push(`${REDIS_KEYS.VIDEO}${videoId}`);
  }
  
  // Tweet-related caches
  if (tweetId) {
    const tweetCachePattern = `${REDIS_KEYS.TWEET_COMMENTS}${tweetId}_*`;
    const tweetKeys = await redisClient.keys(tweetCachePattern);
    cachesToDelete.push(...tweetKeys);
    
    // Invalidate tweet likes (as comment counts may be displayed with tweets)
    cachesToDelete.push(`${REDIS_KEYS.TWEET_LIKES}${tweetId}`);
    cachesToDelete.push(`${REDIS_KEYS.TWEET}${tweetId}`);
  }
  
  // User-related caches
  if (userId) {
    // User's comments
    const userCommentsCachePattern = `${REDIS_KEYS.USER_COMMENTS}${userId}*`;
    const userCommentsKeys = await redisClient.keys(userCommentsCachePattern);
    cachesToDelete.push(...userCommentsKeys);
    
    // User's comment likes
    cachesToDelete.push(`${REDIS_KEYS.USER_COMMENT_LIKES}${userId}`);
    
    // User's video and tweet listings (as they may show comment counts)
    cachesToDelete.push(`${REDIS_KEYS.USER_VIDEOS}${userId}`);
    cachesToDelete.push(`${REDIS_KEYS.USER_TWEETS}${userId}`);
  }
  
  // Delete all gathered caches if any exist
  if (cachesToDelete.length > 0) {
    await redisClient.del(cachesToDelete);
  }
};

// Get all comments for a video (with pagination)
const getVideoComments = asyncHandler(async (req, res) => {
  const { videoId } = req.params;
  const { page = 1, limit = 10 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  if (!videoId) {
    throw new ApiError(400, "Video ID is required");
  }

  try {
    // Cache key for this specific request
    const cacheKey = `${REDIS_KEYS.VIDEO_COMMENTS}${videoId}_page${page}_limit${limit}`;
    
    // Try to get data from cache first
    const cachedData = await redisClient.get(cacheKey);
    if (cachedData) {
      return res
        .status(200)
        .json(new ApiResponse(200, JSON.parse(cachedData), "Comments fetched from cache"));
    }

    // First check if the video exists
    const videoExists = await prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true }
    });

    if (!videoExists) {
      throw new ApiError(404, "Video not found");
    }

    // Get comments with pagination
    const comments = await prisma.comment.findMany({
      where: { videoId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            fullName: true,
            avatar: true
          }
        },
        likes: {
          include: {
            user: {
              select: {
                id: true
              }
            }
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      },
      skip,
      take: parseInt(limit),
    });

    // Get total comments count for pagination
    const totalComments = await prisma.comment.count({
      where: { videoId }
    });

    // Process comments to add necessary properties similar to the video controller
    const processedComments = comments.map(comment => {
      // Format the comment similar to how we format videos
      const formattedComment = {
        ...comment,
        likesCount: comment.likes.length,
        isLiked: false
      };

      // Check if user is authenticated and update like status
      if (req.user) {
        // Check if the current user has liked this comment
        const likeExists = comment.likes.some(like => like.user.id === req.user.id);
        formattedComment.isLiked = likeExists;
      }

      return formattedComment;
    });

    const responseData = {
      comments: processedComments,
      totalComments,
      page: parseInt(page),
      totalPages: Math.ceil(totalComments / parseInt(limit))
    };

    // Cache the response data with expiration
    await redisClient.set(cacheKey, JSON.stringify(responseData), {
      EX: CACHE_EXPIRATION
    });

    // Return the processed comments with pagination info
    return res
      .status(200)
      .json(new ApiResponse(200, responseData, "Comments fetched successfully"));
      
  } catch (error) {
    if (error.code === 'P2023') {
      throw new ApiError(400, "Invalid video ID format");
    }
    throw new ApiError(500, error?.message || "Failed to fetch comments");
  }
});

// Add a new comment to a video
const addVideoComment = asyncHandler(async (req, res) => {
  const { videoId, text } = req.body;
  const userId = req.user.id;
  
  if (!videoId || !text) {
    return res
      .status(400)
      .json(new ApiError(400, "videoId and text are required"));
  }

  try {
    // Check if video exists
    const videoExists = await prisma.video.findUnique({
      where: { id: videoId }
    });

    if (!videoExists) {
      return res.status(404).json(new ApiError(404, "Video not found"));
    }

    const newComment = await prisma.comment.create({
      data: { 
        videoId, 
        userId,
        content: text,
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            fullName: true,
            avatar: true
          }
        }
      }
    });
    
    // Invalidate all relevant caches
    await invalidateCommentCaches(null, videoId, null, userId);
    
    res
      .status(201)
      .json(new ApiResponse(201, newComment, "Comment added successfully"));
  } catch (error) {
    res.status(500).json(new ApiError(500, error?.message || "Error adding comment"));
  }
});

// Update an existing comment
const updateVideoComment = asyncHandler(async (req, res) => {
  const { commentId } = req.params;
  const { text } = req.body;
  const userId = req.user.id;

  if (!text) {
    return res.status(400).json(new ApiError(400, "New text is required"));
  }

  try {
    // First check if the comment exists and belongs to the user
    const existingComment = await prisma.comment.findUnique({
      where: { id: commentId }
    });

    if (!existingComment) {
      return res.status(404).json(new ApiError(404, "Comment not found"));
    }

    if (existingComment.userId !== userId) {
      return res.status(403).json(new ApiError(403, "Not authorized to update this comment"));
    }

    const comment = await prisma.comment.update({
      where: { id: commentId },
      data: { content: text },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            fullName: true,
            avatar: true
          }
        }
      }
    });

    // Invalidate all relevant caches
    await invalidateCommentCaches(
      commentId, 
      existingComment.videoId, 
      existingComment.tweetId, 
      userId
    );
    
    res
      .status(200)
      .json(new ApiResponse(200, comment, "Comment updated successfully"));
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json(new ApiError(404, "Comment not found"));
    }
    res.status(500).json(new ApiError(500, error?.message || "Error updating comment"));
  }
});

// Delete a comment
const deleteVideoComment = asyncHandler(async (req, res) => {
  const { commentId } = req.params;
  const userId = req.user.id;

  try {
    // First check if the comment exists and belongs to the user
    const existingComment = await prisma.comment.findUnique({
      where: { id: commentId }
    });

    if (!existingComment) {
      return res.status(404).json(new ApiError(404, "Comment not found"));
    }

    if (existingComment.userId !== userId) {
      return res.status(403).json(new ApiError(403, "Not authorized to delete this comment"));
    }

    // Store video ID before deleting the comment
    const videoId = existingComment.videoId;

    await prisma.comment.delete({
      where: { id: commentId },
    });

    // Invalidate all relevant caches
    await invalidateCommentCaches(commentId, videoId, null, userId);

    res
      .status(200)
      .json(new ApiResponse(200, null, "Comment deleted successfully"));
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json(new ApiError(404, "Comment not found"));
    }
    res.status(500).json(new ApiError(500, error?.message || "Error deleting comment"));
  }
});

const getAllUserVideoComments = asyncHandler(async (req, res) => {
  const { userId } = req.params;

  // Validate userId
  if (!userId) {
    return res
      .status(400)
      .json(new ApiError(400, "User ID is required"));
  }

  try {
    // Cache key for user video comments
    const cacheKey = `${REDIS_KEYS.USER_COMMENTS}${userId}_videos`;
    
    // Try to get data from cache first
    const cachedData = await redisClient.get(cacheKey);
    if (cachedData) {
      return res.status(200).json(
        new ApiResponse(200, JSON.parse(cachedData), "Comments fetched from cache")
      );
    }

    // Find all comments made by the user with prisma
    const comments = await prisma.comment.findMany({
      where: {
        userId: userId,
        videoId: { not: null }
      },
      select: {
        id: true,
        content: true,
        createdAt: true,
        updatedAt: true,
        videoId: true,
        tweetId: true,
        // Include related video data
        video: {
          select: {
            id: true,
            title: true,
            thumbnail: true,
            duration: true,
            views: true
          }
        },
        // Include user data
        user: {
          select: {
            id: true,
            username: true,
            fullName: true,
            avatar: true
          }
        },
        // Include likes data
        likes: {
          select: {
            id: true,
            likedBy: true,
            createdAt: true,
            user: {
              select: {
                id: true,
                username: true,
                fullName: true
              }
            }
          }
        }
      },
      orderBy: {
        createdAt: 'desc' // Sort by newest first
      }
    });

    // Count the total number of comments
    const totalComments = await prisma.comment.count({
      where: {
        userId: userId,
        videoId: { not: null }
      }
    });

    const responseData = {
      comments,
      totalComments
    };

    // Cache the response data
    await redisClient.set(cacheKey, JSON.stringify(responseData), {
      EX: CACHE_EXPIRATION
    });

    // Return the comments with success status
    return res.status(200).json(
      new ApiResponse(200, responseData, "User video comments fetched successfully")
    );
  } catch (error) {
    console.error("Error fetching user comments:", error);
    return res
      .status(500)
      .json(new ApiError(500, "Failed to fetch user comments"));
  }
});


const getTweetComments = asyncHandler(async (req, res) => {
  const { tweetId } = req.params;
  const { page = 1, limit = 10 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const userId = req.user?.id; // May be undefined for non-authenticated users

  if (!tweetId) {
    throw new ApiError(400, "Tweet ID is required");
  }

  // Create a cache key based on the request parameters
  const cacheKey = `${REDIS_KEYS.TWEET_COMMENTS}${tweetId}_page${page}_limit${limit}`;

  try {
    // Try to get data from cache first
    const cachedData = await redisClient.get(cacheKey);
    
    if (cachedData) {
      // Return cached data if it exists
      return res
        .status(200)
        .json(JSON.parse(cachedData));
    }

    // If not in cache, proceed with database query
    // First check if the tweet exists
    const tweetExists = await prisma.tweet.findUnique({
      where: { id: tweetId },
      select: { id: true }
    });

    if (!tweetExists) {
      throw new ApiError(404, "Tweet not found");
    }

    // Get comments with pagination
    const comments = await prisma.comment.findMany({
      where: { tweetId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            fullName: true,
            avatar: true
          }
        },
        likes: {
          include: {
            user: {
              select: {
                id: true
              }
            }
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      },
      skip,
      take: parseInt(limit),
    });

    // Get total comments count for pagination
    const totalComments = await prisma.comment.count({
      where: { tweetId }
    });

    // Process comments to add necessary properties
    const processedComments = comments.map(comment => {
      // Format the comment with additional properties
      const formattedComment = {
        ...comment,
        likesCount: comment.likes.length,
        isLiked: false
      };

      // Check if user is authenticated and update like status
      if (userId) {
        // Check if the current user has liked this comment
        const likeExists = comment.likes.some(like => like.user.id === userId);
        formattedComment.isLiked = likeExists;
      }

      return formattedComment;
    });

    // Create response data
    const responseData = {
      comments: processedComments,
      totalComments,
      page: parseInt(page),
      totalPages: Math.ceil(totalComments / parseInt(limit))
    };

    // Cache the response
    await redisClient.set(cacheKey, JSON.stringify(responseData), {
      EX: CACHE_EXPIRATION
    });

    // Return the processed comments with pagination info
    return res
      .status(200)
      .json(new ApiResponse(200, responseData, "Comments fetched successfully"));
      
  } catch (error) {
    if (error.code === 'P2023') {
      throw new ApiError(400, "Invalid tweet ID format");
    }
    throw new ApiError(500, error?.message || "Failed to fetch comments");
  }
});

// Add a new comment to a tweet
const addTweetComment = asyncHandler(async (req, res) => {
  const { tweetId, content } = req.body;
  const userId = req.user.id;
  
  if (!tweetId || !content) {
    return res
      .status(400)
      .json(new ApiError(400, "tweetId and content are required"));
  }

  try {
    // Check if tweet exists
    const tweetExists = await prisma.tweet.findUnique({
      where: { id: tweetId }
    });

    if (!tweetExists) {
      return res.status(404).json(new ApiError(404, "Tweet not found"));
    }

    const newComment = await prisma.comment.create({
      data: { 
        tweetId, 
        userId,
        content,
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            fullName: true,
            avatar: true
          }
        }
      }
    });
    
    // Invalidate all relevant caches
    await invalidateCommentCaches(null, null, tweetId, userId);
    
    res
      .status(201)
      .json(new ApiResponse(201, newComment, "Comment added successfully"));
  } catch (error) {
    res.status(500).json(new ApiError(500, error?.message || "Error adding comment"));
  }
});

// Update an existing comment
const updateTweetComment = asyncHandler(async (req, res) => {
  const { commentId } = req.params;
  const { content } = req.body;
  const userId = req.user.id;

  if (!content) {
    return res.status(400).json(new ApiError(400, "Content is required"));
  }

  try {
    // First check if the comment exists and belongs to the user
    const existingComment = await prisma.comment.findUnique({
      where: { id: commentId }
    });

    if (!existingComment) {
      return res.status(404).json(new ApiError(404, "Comment not found"));
    }

    if (existingComment.userId !== userId) {
      return res.status(403).json(new ApiError(403, "Not authorized to update this comment"));
    }

    const comment = await prisma.comment.update({
      where: { id: commentId },
      data: { content },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            fullName: true,
            avatar: true
          }
        }
      }
    });

    // Invalidate all relevant caches
    await invalidateCommentCaches(
      commentId, 
      existingComment.videoId, 
      existingComment.tweetId, 
      userId
    );

    res
      .status(200)
      .json(new ApiResponse(200, comment, "Comment updated successfully"));
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json(new ApiError(404, "Comment not found"));
    }
    res.status(500).json(new ApiError(500, error?.message || "Error updating comment"));
  }
});

// Delete a comment
const deleteTweetComment = asyncHandler(async (req, res) => {
  const { commentId } = req.params;
  const userId = req.user.id;

  try {
    // First check if the comment exists and belongs to the user
    const existingComment = await prisma.comment.findUnique({
      where: { id: commentId }
    });

    if (!existingComment) {
      return res.status(404).json(new ApiError(404, "Comment not found"));
    }

    if (existingComment.userId !== userId) {
      return res.status(403).json(new ApiError(403, "Not authorized to delete this comment"));
    }

    // Store the tweet ID before deleting
    const tweetId = existingComment.tweetId;

    // Delete the specific comment
    await prisma.comment.delete({
      where: { id: commentId },
    });

    // Invalidate all relevant caches
    await invalidateCommentCaches(commentId, null, tweetId, userId);

    res
      .status(200)
      .json(new ApiResponse(200, null, "Comment deleted successfully"));
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json(new ApiError(404, "Comment not found"));
    }
    res.status(500).json(new ApiError(500, error?.message || "Error deleting comment"));
  }
});

// Get all comments by a user (with Redis caching)
const getAllUserTweetComments = asyncHandler(async (req, res) => {
  const { userId } = req.params;

  // Validate userId
  if (!userId) {
    return res
      .status(400)
      .json(new ApiError(400, "User ID is required"));
  }

  // Create cache key for user comments
  const cacheKey = `${REDIS_KEYS.USER_COMMENTS}${userId}_tweets`;

  try {
    // Try to get data from cache first
    const cachedData = await redisClient.get(cacheKey);
    
    if (cachedData) {
      // Return cached data if it exists
      return res
        .status(200)
        .json(JSON.parse(cachedData));
    }

    // Find all comments made by the user
    const comments = await prisma.comment.findMany({
      where: {
        userId: userId,
        tweetId: { not: null },
      },
      select: {
        id: true,
        content: true,
        createdAt: true,
        updatedAt: true,
        tweetId: true,
        // Include related tweet data
        tweet: {
          select: {
            id: true,
            content: true,
            mediaUrl: true,
            createdAt: true,
            user: {
              select: {
                id: true,
                username: true,
                fullName: true,
                avatar: true
              }
            }
          }
        },
        // Include user data
        user: {
          select: {
            id: true,
            username: true,
            fullName: true,
            avatar: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    // Count the total number of comments
    const totalComments = await prisma.comment.count({
      where: {
        userId: userId,
        tweetId: { not: null }
      }
    });

    // Create response data
    const responseData = {
      comments,
      totalComments
    };

    // Cache the response
    await redisClient.set(cacheKey, JSON.stringify(responseData), {
      EX: CACHE_EXPIRATION
    });

    res.status(200).json(
      new ApiResponse(200, responseData, "User tweet comments fetched successfully")
    );
  } catch (error) {
    console.error("Error fetching user comments:", error);
    res.status(500).json(new ApiError(500, "Failed to fetch user comments"));
  }
});

export {
  getVideoComments,
  addVideoComment,
  updateVideoComment,
  deleteVideoComment,
  getAllUserVideoComments,
  getTweetComments,
  addTweetComment,
  updateTweetComment,
  deleteTweetComment,
  getAllUserTweetComments
};