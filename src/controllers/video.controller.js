import { Types, isValidObjectId } from "mongoose";
import Video from "../models/video.model.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import { uploadOnCloudinary } from "../utils/cloudinary.js";
import formatDuration from "../utils/formatDuration.js";
import {
  checkCache,
  generateCacheKey,
  revalidateCache,
  revalidateRelatedCaches,
  setCache,
} from "../utils/redis.util.js";
// Get all videos

const getAllVideos = asyncHandler(async (req, res) => {
  // Extract pagination parameters from query string
  const {
    page = 1,
    limit = 10,
    sortBy = "createdAt",
    sortType = "desc",
    userId,
    q,
  } = req.query || {};
  console.log("q:", q);
  // Generate cache key

  // search query
  const searchQuery = { isPublished: true };
  if (q) {
    searchQuery.$or = [
      { title: { $regex: q, $options: "i" } },
      { description: { $regex: q, $options: "i" } },
      { tags: { $in: q.split(" ").map((val) => val.toLowerCase()) } },
    ];
  }
  // console.log("searchQuery:", JSON.stringify(searchQuery, null, 2));
  if (userId) {
    if (!isValidObjectId(userId)) {
      throw new ApiError(400, "Invalid User Id");
    }
    const mongoId = new Types.ObjectId(userId);
    searchQuery.owner = mongoId;
  }
  // sort query
  const sortQuery = {};
  if (sortBy) {
    sortQuery[sortBy] = sortType === "desc" ? -1 : 1;
  } else {
    sortQuery.createdAt = -1;
  }
  const cacheKey = generateCacheKey("all-videos", req.query);
  // await revalidateRelatedCaches(req, "all-videos");
  // Check cache
  const cachedRes = await checkCache(req, cacheKey);
  if (cachedRes) {
    /* console.log(
        "cacheRes",
        util.inspect(cachedRes, { showHidden: false, depth: null, colors: true })
      ); */

    return res.status(200).json(cachedRes);
  }

  // Create the aggregation pipeline
  const aggregateQuery = Video.aggregate([
    {
      $match: searchQuery,
    },
    {
      $sort: sortQuery,
    },
    {
      $lookup: {
        from: "users",
        localField: "owner",
        foreignField: "_id",
        as: "owner",
        pipeline: [
          {
            $project: {
              _id: 1,
              username: 1,
              fullName: 1,
              email: 1,
              avatar: 1,
              coverImage: 1,
            },
          },
        ],
      },
    },
    {
      $set: {
        owner: {
          $first: "$owner",
        },
      },
    },
  ]);

  // Use aggregatePaginate for pagination
  const options = {
    page: parseInt(page, 10),
    limit: parseInt(limit, 10),
  };
  // Use aggregatePaginate with the aggregation object (not array of stages)
  const result = await Video.aggregatePaginate(aggregateQuery, options);
  // Create the response object
  const response = new ApiResponse(
    200,
    {
      videos: result.docs,
      totalVideos: result.totalDocs,
      totalPages: result.totalPages,
      currentPage: result.page,
      hasNextPage: result.hasNextPage,
      hasPrevPage: result.hasPrevPage,
    },
    "Videos found"
  );
  // Cache the response
  await setCache(req, response, cacheKey);
  return res.status(200).json(response);
});

// Get video by id
const getVideoById = asyncHandler(async (req, res) => {
  const videoId = req.params.id;
  // Generate cache key
  const cacheKey = generateCacheKey("video", videoId);
  // Check cache
  await checkCache(req, cacheKey);
  const video = await Video.findById(videoId).populate({
    path: "owner",
    model: "User",
    select: "_id username fullName email avatar",
  });

  if (!video) {
    throw new ApiError(404, "Video not found");
  }
  // Cache the response
  const response = new ApiResponse(200, video, "Video found");
  await setCache(req, response, cacheKey);
  return res.status(200).json(response);
});

// Update video by id
const updateVideoById = asyncHandler(async (req, res) => {
  const { title, description } = req.body;
  const thumbnailLocalPath = req.file?.path;
  if (
    [title, description, thumbnailLocalPath].every(
      (value) => value?.trim() === ""
    )
  ) {
    throw new ApiError(400, "Please provide All required fields");
  }
  const thumbnail = await uploadOnCloudinary(thumbnailLocalPath);
  if (!thumbnail?.public_id) {
    throw new ApiError(500, "Failed to update thumbnail");
  }
  const video = await Video.findByIdAndUpdate(
    req.params.id,
    {
      $set: {
        title,
        description,
        thumbnail: {
          url: thumbnail.secure_url,
          public_id: thumbnail.public_id,
        },
      },
    },
    {
      new: true,
    }
  );
  if (!video) {
    throw new ApiError(500, "Failed to update video");
  }
  // delete the video cache
  const cacheKey = generateCacheKey("video", req.params.id);
  await revalidateCache(req, cacheKey);
  // revalidate all videos cache
  await revalidateRelatedCaches(req, "all-videos");
  return res.status(200).json(new ApiResponse(200, video, "Video updated"));
});

// Update all video
const updateAllVideo = asyncHandler(async (req, res) => {
  const { title, description, tags } = req.body;
  if (
    [title, description].every((value) => value?.trim() === "") ||
    tags.length === 0
  ) {
    throw new ApiError(400, "Please provide All required fields");
  }

  const result = await Video.updateMany(
    {},
    {
      $set: {
        title,
        description,
        tags,
      },
    }
  );
  if (result?.modifiedCount === 0) {
    throw new ApiError(500, "Failed to update videos");
  }
  // revalidate all videos cache
  await revalidateRelatedCaches(req, "all-videos");
  return res.status(200).json(new ApiResponse(200, "All Videos Updated"));
});

//  Publish video
const publishVideo = asyncHandler(async (req, res) => {
  const { title, description, tags } = req.body;
  const videoLocalPath = (req.files?.videoFile ?? [])[0]?.path;
  const thumbnailLocalPath = (req.files?.thumbnail ?? [])[0]?.path;
  if (!videoLocalPath || !thumbnailLocalPath) {
    throw new ApiError(400, "Thumbnail and Video Files are required");
  }

  if (
    [title, description].some((value) => value?.trim() === "") ||
    tags.length === 0
  ) {
    throw new ApiError(400, "Please provide All required fields");
  }
  //  upload video and thumbnail on cloudinary
  const videoFile = await uploadOnCloudinary(videoLocalPath);
  const thumbnail = await uploadOnCloudinary(thumbnailLocalPath);

  if (!videoFile?.public_id) {
    throw new ApiError(500, "Failed to upload video file");
  }
  if (!thumbnail?.public_id) {
    throw new ApiError(500, "Failed to upload thumbnail file");
  }

  const duration = formatDuration(videoFile.duration);
  const video = await Video.create({
    title,
    description,
    video: {
      url: videoFile.secure_url,
      public_id: videoFile.public_id,
    },
    thumbnail: {
      url: thumbnail.secure_url,
      public_id: thumbnail.public_id,
    },
    tags,
    duration,
    owner: req.user._id,
  });
  // revalidate all video cache
  await revalidateRelatedCaches(req, "all-videos");
  return res
    .status(201)
    .json(new ApiResponse(201, video, "Video published successfully"));
});

// Delete video
const deleteVideo = asyncHandler(async (req, res) => {
  const video = await Video.findByIdAndDelete(req.params.id);
  if (!video) {
    throw new ApiError(500, "Failed to delete video");
  }
  // revalidate video cache
  const cacheKey = generateCacheKey("video", req.params.id);
  await revalidateCache(req, cacheKey);
  // revalidate all videos cache
  await revalidateRelatedCaches(req, "all-videos");
  return res.status(200).json(new ApiResponse(200, {}, "Video deleted"));
});

// update video publish status
const updateVideoPublishStatus = asyncHandler(async (req, res) => {
  const videoId = req.params.id;

  const video = await Video.findByIdAndUpdate(
    videoId,
    {
      $set: {
        isPublished: req.body.isPublished,
      },
    },
    {
      new: true,
    }
  );
  if (!video) {
    throw new ApiError(500, "Failed to update video publish status");
  }
  // Generate cache key
  const cacheKey = generateCacheKey("video", videoId);
  await revalidateCache(req, cacheKey);
  // revalidate all videos cache
  await revalidateRelatedCaches(req, "all-videos");
  return res
    .status(200)
    .json(new ApiResponse(200, video, "Video publish status updated"));
});

const getRelatedVideos = asyncHandler(async (req, res) => {
  const videoId = req.params.id;
  console.log("videoId:", videoId);
  if (!isValidObjectId(videoId)) {
    throw new ApiError(400, "Invalid video Id");
  }
  const video = await Video.findById(videoId);
  if (!video) {
    throw new ApiError(404, "Video not found");
  }
  const cacheKey = generateCacheKey("related-videos", videoId);
  await revalidateCache(req, cacheKey);
  // Check cache
  const cachedRes = await checkCache(req, cacheKey);
  if (cachedRes) {
    return res.status(200).json(cachedRes);
  }
  const relatedVideos = await Video.find({
    _id: { $ne: videoId },
    tags: { $in: video.tags },
  }).populate({
    path: "owner",
    model: "User",
    select: "_id username fullName email avatar",
  });
  // Cache the response
  const response = new ApiResponse(200, relatedVideos, "Related videos found");
  // await setCache(req, response, cacheKey);
  return res.status(200).json(response);
});

export {
  deleteVideo,
  getAllVideos,
  getRelatedVideos,
  getVideoById,
  publishVideo,
  updateAllVideo,
  updateVideoById,
  updateVideoPublishStatus,
};
