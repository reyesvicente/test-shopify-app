import { useState, useEffect, useRef, useCallback } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigate } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import imageCompression from "browser-image-compression";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");
  const pageSize = 50; // Increased from 10 to 50

  // Fetch products with images
  const response = await admin.graphql(
    `#graphql
      query ($cursor: String, $pageSize: Int!) {
        products(first: $pageSize, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              title
              images(first: 1) {
                edges {
                  node {
                    id
                    url
                  }
                }
              }
            }
          }
        }
      }`,
    {
      variables: {
        cursor: cursor || null,
        pageSize
      }
    }
  );

  const {
    data: { products },
  } = await response.json();

  // Get compression history
  const compressionHistory = await prisma.compressedImage.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10
  });

  return json({ 
    products: products.edges,
    pageInfo: products.pageInfo,
    compressionHistory 
  });
};

export async function action({ request }) {
  try {
    const { admin } = await authenticate.admin(request);
    
    let data;
    try {
      const contentType = request.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        data = await request.json();
      } else {
        const formData = await request.formData();
        data = {
          productId: formData.get("productId"),
          imageId: formData.get("imageId"),
          compressedImage: formData.get("compressedImage")
        };
      }
    } catch (error) {
      console.error("Error parsing request:", error);
      throw new Error("Invalid request format");
    }

    const { productId, imageId, compressedImage } = data;

    if (!productId || !compressedImage) {
      throw new Error("Missing required fields: productId or compressedImage");
    }

    // Validate base64 data
    let base64Data;
    try {
      base64Data = compressedImage.includes('base64,') 
        ? compressedImage.split('base64,')[1] 
        : compressedImage;
        
      // Validate base64 format
      if (!/^[A-Za-z0-9+/=]+$/.test(base64Data)) {
        throw new Error("Invalid base64 format");
      }
    } catch (error) {
      console.error("Error processing base64 data:", error);
      throw new Error("Invalid image data format");
    }

    // First delete the existing image if needed
    if (imageId) {
      console.log("Deleting existing image:", imageId);
      const deleteResponse = await admin.graphql(
        `#graphql
          mutation productDeleteImages($input: ProductDeleteImagesInput!) {
            productDeleteImages(input: $input) {
              deletedImageIds
              userErrors {
                field
                message
              }
            }
          }`,
        {
          variables: {
            input: {
              productId: productId,
              imageIds: [imageId]
            },
          },
        }
      );

      const deleteResult = await deleteResponse.json();
      console.log("Delete response:", deleteResult);

      if (deleteResult.data?.productDeleteImages?.userErrors?.length > 0) {
        const error = deleteResult.data.productDeleteImages.userErrors[0];
        console.error("Error deleting image:", error);
        throw new Error(`Failed to delete image: ${error.message}`);
      }
    }

    // Create new image
    console.log("Creating new image for product:", productId);
    const createResponse = await admin.graphql(
      `#graphql
        mutation productCreateMedia($input: ProductCreateMediaInput!) {
          productCreateMedia(input: $input) {
            media {
              ... on MediaImage {
                id
                image {
                  id
                  url
                }
              }
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        variables: {
          input: {
            productId: productId,
            media: [{
              originalSource: base64Data,
              mediaContentType: "IMAGE"
            }]
          }
        },
      }
    );

    const createResult = await createResponse.json();
    console.log("Create image response:", createResult);

    if (createResult.data?.productCreateMedia?.userErrors?.length > 0) {
      const error = createResult.data.productCreateMedia.userErrors[0];
      console.error("Error creating image:", error);
      throw new Error(`Failed to create image: ${error.message}`);
    }

    const newImage = createResult.data?.productCreateMedia?.media?.[0]?.image;
    if (!newImage) {
      throw new Error("No image data in response");
    }

    return json({ 
      success: true,
      image: newImage
    });

  } catch (error) {
    console.error("Error in action:", error);
    return json(
      { 
        success: false, 
        error: error.message || "An unknown error occurred",
        details: error.stack
      },
      { 
        status: 400,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
  }
}

export default function Index() {
  const { products, pageInfo } = useLoaderData();
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [isCompressing, setIsCompressing] = useState(false);
  const [error, setError] = useState("");
  const [compressionStats, setCompressionStats] = useState(null);
  const [imageSizes, setImageSizes] = useState({});
  const [bulkCompressionProgress, setBulkCompressionProgress] = useState(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isCancelled, setIsCancelled] = useState(false);
  const navigate = useNavigate();
  const abortControllerRef = useRef(null);

  // Get CSRF token from meta tag
  const getCSRFToken = () => {
    const csrfToken = document.querySelector('meta[name="csrf-token"]');
    return csrfToken ? csrfToken.getAttribute('content') : null;
  };

  // Function to make authenticated fetch requests
  const authenticatedFetch = async (url, options = {}) => {
    const csrfToken = getCSRFToken();
    const headers = {
      'Accept': 'application/json',
      'X-CSRF-Token': csrfToken,
      ...(options.headers || {})
    };

    return fetch(url, {
      ...options,
      headers,
      credentials: 'same-origin' // Include cookies
    });
  };

  // Function to fetch image size
  const fetchImageSize = async (url, productId) => {
    try {
      const response = await authenticatedFetch(url);
      if (!response.ok) throw new Error('Failed to fetch image');
      const blob = await response.blob();
      setImageSizes(prev => ({
        ...prev,
        [productId]: blob.size
      }));
    } catch (error) {
      console.error('Error fetching image size:', error);
    }
  };

  // Fetch sizes for all images on component mount
  useEffect(() => {
    console.log('Checking products:', products);
    products.forEach(product => {
      console.log('Checking product:', product.node.id);
      const imageUrl = product.node.images?.edges[0]?.node?.url;
      if (imageUrl) {
        console.log('Fetching image size for URL:', imageUrl);
        fetchImageSize(imageUrl, product.node.id);
      } else {
        console.warn('No image URL found for product:', product.node.id);
      }
    });
  }, [products]);

  // Function to compress a single image
  const compressImage = async (imageUrl) => {
    const response = await authenticatedFetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }
    const blob = await response.blob();
    
    const options = {
      maxSizeMB: 1,
      maxWidthOrHeight: 2048,
      useWebWorker: true,
      initialQuality: 0.8,
      preserveExif: true,
    };

    const compressedFile = await imageCompression(blob, options);
    return {
      originalSize: blob.size,
      compressedSize: compressedFile.size,
      compressedFile,
    };
  };

  // Function to handle bulk compression
  const compressAndUpdateImage = async (product, signal) => {
    console.log('Compress button clicked for product:', product.node.id);
    setIsCompressing(true);
    try {
      const image = product.node.images?.edges[0]?.node;
      if (!image) {
        console.error('No image found for product:', product.node.id);
        throw new Error('No image found');
      }

      const imageUrl = image.url;
      console.log('Fetching image from URL:', imageUrl);

      // Fetch the image
      const response = await fetch(imageUrl);
      const blob = await response.blob();

      // Convert to base64
      const reader = new FileReader();
      const base64Promise = new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
      });
      reader.readAsDataURL(blob);
      const base64String = await base64Promise;

      // Compress the image
      console.log('Original image size:', blob.size, 'bytes');
      const options = {
        maxSizeMB: 0.5,
        maxWidthOrHeight: 1024,
        useWebWorker: true,
        fileType: 'image/jpeg',
      };

      console.log('Compressing with options:', options);
      const compressedFile = await imageCompression(blob, options);
      console.log('Compression result:', {
        originalSize: blob.size,
        compressedSize: compressedFile.size,
        ratio: compressedFile.size / blob.size
      });

      // Convert compressed image to base64
      const compressedReader = new FileReader();
      const compressedBase64Promise = new Promise((resolve, reject) => {
        compressedReader.onload = () => resolve(compressedReader.result);
        compressedReader.onerror = reject;
      });
      compressedReader.readAsDataURL(compressedFile);
      const compressedBase64 = await compressedBase64Promise;

      console.log('Base64 string length:', compressedBase64.length);

      // Only upload if compressed size is smaller
      if (compressedFile.size >= blob.size) {
        console.log('Compressed size is not smaller, skipping upload');
        throw new Error('Compressed size is not smaller than original');
      }

      const csrfToken = getCSRFToken();
      console.log('Uploading compressed image');

      const uploadResponse = await fetch("/app", {
        method: "POST",
        headers: {
          'X-CSRF-Token': csrfToken,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        credentials: 'same-origin',
        signal,
        body: JSON.stringify({
          productId: product.node.id,
          imageId: image.id,
          compressedImage: compressedBase64
        })
      });

      console.log('Upload request headers:', Object.fromEntries(uploadResponse.headers.entries()));
      console.log('Upload request body:', JSON.stringify({
        productId: product.node.id,
        imageId: image.id,
        compressedImage: compressedBase64
      }));

      // Log response details
      console.log('Response status:', uploadResponse.status);
      console.log('Response headers:', Object.fromEntries(uploadResponse.headers.entries()));

      const text = await uploadResponse.text();
      console.log('Response text:', text.substring(0, 200));

      let responseData;
      try {
        responseData = JSON.parse(text);
      } catch (error) {
        console.error('Error parsing response:', error);
        console.error('Raw response text:', text);
        throw new Error('Server error occurred');
      }

      console.log('Parsed response data:', responseData);

      if (!uploadResponse.ok || !responseData.success) {
        const errorMessage = responseData.error || `Upload failed: ${uploadResponse.status}`;
        console.error('Error response:', responseData);
        throw new Error(errorMessage);
      }

      return responseData;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw error;
      }
      console.error('Error processing image:', error);
      console.error('Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack
      });
      throw error;
    } finally {
      setIsCompressing(false);
      console.log('Compression process completed for product:', product.node.id);
    }
  };

  const compressAllImages = async () => {
    console.log('Starting bulk compression');
    try {
      setIsCompressing(true);
      setIsCancelled(false);
      setError("");
      
      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;
      
      const productsWithImages = products.filter(
        product => product.node.images?.edges.length > 0
      );

      setBulkCompressionProgress({
        total: productsWithImages.length,
        completed: 0,
        successful: 0,
        failed: 0,
        results: [],
      });

      const batchSize = 3;
      const results = [];
      
      for (let i = 0; i < productsWithImages.length && !isCancelled; i += batchSize) {
        const batch = productsWithImages.slice(i, i + batchSize);
        const batchPromises = batch.map(async (product) => {
          try {
            if (isCancelled) {
              return { cancelled: true };
            }

            const imageNode = product.node.images?.edges[0]?.node;
            if (!imageNode) {
              setBulkCompressionProgress(prev => ({
                ...prev,
                completed: prev.completed + 1,
                results: [...prev.results, {
                  productId: product.node.id,
                  status: 'skipped',
                  message: 'No image found'
                }]
              }));
              return null;
            }

            console.log('Processing image:', {
              productId: product.node.id,
              imageUrl: imageNode.url,
              imageId: imageNode.id
            });

            // Fetch and compress image
            const response = await fetch(imageNode.url, { signal });
            if (!response.ok) {
              throw new Error(`Failed to fetch image: ${response.statusText}`);
            }
            const blob = await response.blob();
            console.log('Original image size:', blob.size, 'bytes');
            
            if (isCancelled) {
              return { cancelled: true };
            }

            const options = {
              maxSizeMB: 1,
              maxWidthOrHeight: 2048,
              useWebWorker: true,
              initialQuality: 0.8,
              preserveExif: true,
            };

            console.log('Compressing with options:', options);
            const compressedFile = await imageCompression(blob, options);
            const compressedSize = compressedFile.size;
            const originalSize = blob.size;
            console.log('Compression result:', {
              originalSize,
              compressedSize,
              reduction: ((originalSize - compressedSize) / originalSize * 100).toFixed(2) + '%'
            });

            if (compressedSize >= originalSize) {
              console.log('Skipping - no size reduction achieved');
              setBulkCompressionProgress(prev => ({
                ...prev,
                completed: prev.completed + 1,
                results: [...prev.results, {
                  productId: product.node.id,
                  status: 'skipped',
                  message: 'No size reduction achieved'
                }]
              }));
              return null;
            }

            // Convert to base64
            const base64String = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(compressedFile);
            });
            console.log('Base64 string length:', base64String.length);

            if (isCancelled) {
              return { cancelled: true };
            }

            // Upload compressed image
            const formData = new FormData();
            formData.append("productId", product.node.id);
            formData.append("imageId", imageNode.id);
            formData.append("compressedImage", base64String);

            console.log('Uploading compressed image');
            const result = await compressAndUpdateImage(product, signal);
            console.log('Upload successful:', result);

            setBulkCompressionProgress(prev => ({
              ...prev,
              completed: prev.completed + 1,
              successful: prev.successful + 1,
              results: [...prev.results, {
                productId: product.node.id,
                status: 'success',
                originalSize: formatFileSize(originalSize),
                compressedSize: formatFileSize(compressedSize),
                savedPercentage: (((originalSize - compressedSize) / originalSize) * 100).toFixed(1)
              }]
            }));

            return {
              productId: product.node.id,
              success: true,
            };
          } catch (error) {
            if (error.name === 'AbortError') {
              return { cancelled: true };
            }
            console.error(`Error processing product ${product.node.id}:`, error);
            setBulkCompressionProgress(prev => ({
              ...prev,
              completed: prev.completed + 1,
              failed: prev.failed + 1,
              results: [...prev.results, {
                productId: product.node.id,
                status: 'failed',
                error: error.message
              }]
            }));
            return {
              productId: product.node.id,
              success: false,
              error: error.message,
            };
          }
        });

        try {
          if (!isCancelled) {
            const batchResults = await Promise.all(batchPromises);
            if (batchResults.some(r => r && r.cancelled)) {
              break;
            }
            results.push(...batchResults.filter(r => r !== null && !r.cancelled));
          } else {
            break;
          }
        } catch (error) {
          console.error("Batch processing error:", error);
          if (error.name === 'AbortError') {
            break;
          }
        }

        if (!isCancelled) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      if (!isCancelled && results.some(r => r && r.success)) {
        navigate(".", { replace: true });
      }
    } catch (err) {
      console.error("Bulk compression error:", err);
      setError(err.message || "Error during bulk compression");
    } finally {
      setIsCompressing(false);
    }
  };

  const cancelCompression = useCallback(() => {
    console.log("Cancelling compression...");
    setIsCancelled(true);
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const handleSingleImageCompression = async (product) => {
    try {
      console.log('Starting single image compression for product:', product.node.id);
      setSelectedProduct(product);
      setIsCompressing(true);
      setError("");

      // Initialize new AbortController for this compression
      abortControllerRef.current = new AbortController();

      const result = await compressAndUpdateImage(product, abortControllerRef.current.signal);
      console.log('Compression successful:', result);

      // Update compression stats
      setCompressionStats({
        originalSize: formatFileSize(result.originalSize),
        compressedSizeLocal: formatFileSize(result.compressedSize),
        finalSize: formatFileSize(result.finalSize),
        savedPercentage: ((result.originalSize - result.finalSize) / result.originalSize * 100).toFixed(1)
      });

    } catch (error) {
      console.error('Single compression error:', error);
      setError(error.message || "Error compressing image");
    } finally {
      setIsCompressing(false);
      // Clean up the abort controller
      abortControllerRef.current = null;
    }
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-2xl font-bold">Product Image Compressor</h1>
        <div className="space-x-4">
          <button
            onClick={compressAllImages}
            disabled={isCompressing}
            className={`px-4 py-2 rounded ${
              isCompressing
                ? "bg-gray-300 cursor-not-allowed"
                : "bg-green-600 hover:bg-green-700 text-white"
            }`}
          >
            {isCompressing ? "Compressing..." : "Compress All Images"}
          </button>
          {isCompressing && (
            <button
              onClick={cancelCompression}
              className="px-4 py-2 rounded bg-red-600 hover:bg-red-700 text-white"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative" role="alert">
          <span className="block sm:inline">{error}</span>
        </div>
      )}

      {/* Bulk Compression Progress */}
      {bulkCompressionProgress && (
        <div className="mb-8 bg-white shadow rounded-lg p-4">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold">Bulk Compression Progress</h2>
            {isCancelled && (
              <span className="text-red-600 font-medium">Cancelled</span>
            )}
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-sm text-gray-600">
              <span>Progress: {bulkCompressionProgress.completed} / {bulkCompressionProgress.total}</span>
              <span>Success: {bulkCompressionProgress.successful}</span>
              <span>Failed: {bulkCompressionProgress.failed}</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2.5">
              <div 
                className="bg-blue-600 h-2.5 rounded-full transition-all duration-500"
                style={{ width: `${(bulkCompressionProgress.completed / bulkCompressionProgress.total) * 100}%` }}
              ></div>
            </div>
          </div>

          {/* Results Table */}
          {bulkCompressionProgress.results.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Product ID</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Details</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {bulkCompressionProgress.results.map((result, index) => (
                    <tr key={index}>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{result.productId}</td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                          result.status === 'success' ? 'bg-green-100 text-green-800' :
                          result.status === 'failed' ? 'bg-red-100 text-red-800' :
                          'bg-yellow-100 text-yellow-800'
                        }`}>
                          {result.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-500">
                        {result.status === 'success' ? (
                          <>
                            {result.originalSize} → {result.compressedSize} ({result.savedPercentage}% saved)
                          </>
                        ) : result.status === 'failed' ? (
                          <span className="text-red-600">{result.error}</span>
                        ) : (
                          result.message
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {products.map((product) => {
          const image = product.node.images?.edges[0]?.node;
          const isSelected = selectedProduct?.node.id === product.node.id;
          const imageSize = imageSizes[product.node.id];
          
          return (
            <div key={product.node.id} className="border rounded-lg p-4 space-y-4">
              <h2 className="text-lg font-semibold">{product.node.title}</h2>
              {/* Image Display */}
              {image && (
                <div className="space-y-2">
                  <img
                    src={image.url}
                    alt={product.node.title}
                    className="w-full h-48 object-cover rounded"
                  />
                  {/* Image Details */}
                  <div className="text-sm text-gray-600 space-y-1">
                    <p>Current Size: {imageSize ? formatFileSize(imageSize) : 'Loading...'}</p>
                    <p>Image ID: {image.id}</p>
                    <p className="truncate">
                      URL: <a href={image.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                        {image.url}
                      </a>
                    </p>
                  </div>
                </div>
              )}
              {/* Compression Button */}
              <button
                onClick={() => handleSingleImageCompression(product)}
                disabled={isCompressing && isSelected}
                className={`w-full px-4 py-2 rounded ${
                  isCompressing && isSelected
                    ? "bg-gray-300 cursor-not-allowed"
                    : "bg-blue-600 hover:bg-blue-700 text-white"
                }`}
              >
                {isCompressing && isSelected ? "Compressing..." : "Compress Image"}
              </button>
              {/* Compression Results */}
              {isSelected && compressionStats && (
                <div className="mt-4 bg-green-50 border border-green-200 rounded p-3">
                  <h3 className="font-semibold text-green-800 mb-2">Compression Results:</h3>
                  <div className="space-y-1 text-sm text-green-700">
                    <p>Original Size: {compressionStats.originalSize}</p>
                    <p>Compressed Size: {compressionStats.compressedSizeLocal}</p>
                    <p>Space Saved: {compressionStats.savedPercentage}%</p>
                    <p className="text-xs text-gray-600 mt-2">Note: The final size may vary slightly due to Shopify's processing.</p>
                  </div>
                </div>
              )}
              {/* Loading Indicator */}
              {isSelected && isCompressing && (
                <div className="mt-4 text-center text-gray-600">
                  <div className="animate-spin inline-block w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full"></div>
                  <p className="mt-2">Processing image...</p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Load More Button */}
      {pageInfo?.hasNextPage && (
        <div className="mt-8 text-center">
          <button
            onClick={() => {
              setIsLoadingMore(true);
              navigate(`?cursor=${pageInfo.endCursor}`, { replace: true });
            }}
            disabled={isLoadingMore}
            className={`px-6 py-2 rounded ${
              isLoadingMore
                ? "bg-gray-300 cursor-not-allowed"
                : "bg-blue-600 hover:bg-blue-700 text-white"
            }`}
          >
            {isLoadingMore ? "Loading..." : "Load More Products"}
          </button>
        </div>
      )}
    </div>
  );
}
