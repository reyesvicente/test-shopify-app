import { useState, useEffect } from "react";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigate } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import imageCompression from "browser-image-compression";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  // Fetch products with images
  const response = await admin.graphql(
    `#graphql
      query {
        products(first: 10) {
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
      }`
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
    compressionHistory 
  });
};

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = formData.get("productId");
  const imageId = formData.get("imageId");
  const compressedImage = formData.get("compressedImage");

  try {
    console.log("Starting image update for product:", productId);

    // First delete the existing image
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
        throw new Error(deleteResult.data.productDeleteImages.userErrors[0].message);
      }
      console.log("Successfully deleted old image");
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
              originalSource: compressedImage,
              mediaContentType: "IMAGE"
            }]
          }
        },
      }
    );

    const createResult = await createResponse.json();
    console.log("Create image response:", createResult);

    if (createResult.data?.productCreateMedia?.userErrors?.length > 0) {
      throw new Error(createResult.data.productCreateMedia.userErrors[0].message);
    }

    // Verify the image was saved
    const verifyResponse = await admin.graphql(
      `#graphql
        query getProduct($id: ID!) {
          product(id: $id) {
            images(first: 1) {
              edges {
                node {
                  id
                  url
                }
              }
            }
          }
        }`,
      {
        variables: {
          id: productId,
        },
      }
    );

    const verifyResult = await verifyResponse.json();
    console.log("Verify response:", verifyResult);

    if (!verifyResult.data?.product?.images?.edges?.length) {
      throw new Error("Failed to verify image was saved");
    }

    return json({ 
      status: "success",
      data: createResult.data.productCreateMedia.media[0]
    });
  } catch (error) {
    console.error("Failed to update image:", error);
    return json({ 
      status: "error",
      error: error.message || "Failed to update image" 
    }, { 
      status: 500 
    });
  }
}

export default function Index() {
  const { products, compressionHistory } = useLoaderData();
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [isCompressing, setIsCompressing] = useState(false);
  const [error, setError] = useState("");
  const [compressionStats, setCompressionStats] = useState(null);
  const [imageSizes, setImageSizes] = useState({});
  const submit = useSubmit();
  const navigate = useNavigate();

  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // Function to fetch image size
  const fetchImageSize = async (url, productId) => {
    try {
      const response = await fetch(url);
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
    products.forEach(product => {
      const imageUrl = product.node.images.edges[0]?.node?.url;
      if (imageUrl) {
        fetchImageSize(imageUrl, product.node.id);
      }
    });
  }, [products]);

  const compressAndUpdateImage = async (product) => {
    try {
      setIsCompressing(true);
      setError("");
      setSelectedProduct(product);
      setCompressionStats(null);

      const imageNode = product.node.images.edges[0]?.node;
      if (!imageNode) {
        throw new Error("No image found for this product");
      }

      console.log("Starting compression for image:", imageNode.url);

      // Fetch the image
      const response = await fetch(imageNode.url);
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.statusText}`);
      }
      const blob = await response.blob();
      
      console.log("Original image size:", formatFileSize(blob.size));

      const options = {
        maxSizeMB: 1,
        maxWidthOrHeight: 2048,
        useWebWorker: true,
        initialQuality: 0.8,
        preserveExif: true,
      };

      const compressedFile = await imageCompression(blob, options);
      const compressedSize = compressedFile.size;
      console.log("Compressed image size:", formatFileSize(compressedSize));
      
      // Only proceed if we actually reduced the file size
      if (compressedSize >= blob.size) {
        console.log("Skipping upload - no size reduction achieved");
        setCompressionStats({
          originalSize: formatFileSize(blob.size),
          compressedSizeLocal: formatFileSize(compressedSize),
          finalSize: formatFileSize(blob.size),
          savedPercentage: 0,
        });
        return;
      }

      // Convert compressed file to base64
      const base64String = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(compressedFile);
      });

      console.log("Uploading compressed image...");
      
      // Create form data and submit
      const formData = new FormData();
      formData.append("productId", product.node.id);
      formData.append("imageId", imageNode.id);
      formData.append("compressedImage", base64String);

      // Submit using Remix's submit function
      const result = await submit(formData, { 
        method: "post",
        action: "?index",
        encType: "multipart/form-data"
      });

      // Set compression stats with the local compressed size
      // since we know this is accurate
      setCompressionStats({
        originalSize: formatFileSize(blob.size),
        compressedSizeLocal: formatFileSize(compressedSize),
        finalSize: formatFileSize(compressedSize), // Using local size as it's more accurate
        savedPercentage: (
          ((blob.size - compressedSize) / blob.size) *
          100
        ).toFixed(1),
      });

      // Wait a bit to ensure the image is saved, then refresh
      await new Promise(resolve => setTimeout(resolve, 2000));
      navigate(".", { replace: true });
    } catch (err) {
      console.error("Compression error:", err);
      setError(err.message || "Error compressing image");
    } finally {
      setIsCompressing(false);
    }
  };

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-2xl font-bold mb-4">Product Image Compressor</h1>
      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative" role="alert">
          <span className="block sm:inline">{error}</span>
        </div>
      )}
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {products.map((product) => {
          const image = product.node.images.edges[0]?.node;
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
                onClick={() => compressAndUpdateImage(product)}
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
    </div>
  );
}
