-- CreateTable
CREATE TABLE "CompressedImage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "originalImageId" TEXT NOT NULL,
    "newImageId" TEXT NOT NULL,
    "originalSize" REAL NOT NULL,
    "compressedSize" REAL NOT NULL,
    "savedPercentage" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
