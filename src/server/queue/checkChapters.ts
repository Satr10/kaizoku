import { Prisma, PrismaClient } from '@prisma/client';
import { Job, Queue, Worker } from 'bullmq';
import path from 'path';
import { logger } from '../../utils/logging';
import { sanitizer } from '../../utils/sanitize';
import { findMissingChapterFiles, getChaptersFromLocal } from '../utils/mangal';
import { downloadQueue } from './download';

const cronMap = {
  daily: '0 0 * * *',
  hourly: '0 * * * *',
  minutely: '* * * * *',
  weekly: '0 * * * 7',
};

const prisma = new PrismaClient();

const mangaWithLibrary = Prisma.validator<Prisma.MangaArgs>()({
  include: { library: true },
});

export type MangaWithLibrary = Prisma.MangaGetPayload<typeof mangaWithLibrary>;

const checkChapters = async (manga: MangaWithLibrary) => {
  logger.info(`Checking for new chapters: ${manga.title}`);
  const mangaDir = path.resolve(manga.library.path, sanitizer(manga.title));
  const missingChapterFiles = await findMissingChapterFiles(mangaDir, manga.source, manga.title);

  if (missingChapterFiles.length === 0) {
    logger.info(`There are no missing chapter files for ${manga.title}`);

    const localChapters = await getChaptersFromLocal(mangaDir);

    await prisma.chapter.deleteMany({
      where: {
        mangaId: manga.id,
        index: {
          notIn: localChapters.map((chapter) => chapter.index),
        },
        fileName: {
          notIn: localChapters.map((chapter) => chapter.fileName),
        },
      },
    });

    const dbChapters = await prisma.chapter.findMany({
      where: {
        mangaId: manga.id,
      },
    });

    const missingDbChapters = localChapters.filter(
      (localChapter) => dbChapters.findIndex((dbChapter) => dbChapter.index === localChapter.index) < 0,
    );

    await Promise.all(
      missingDbChapters.map(async (chapter) => {
        return prisma.chapter.create({
          data: {
            ...chapter,
            mangaId: manga.id,
          },
        });
      }),
    );

    return;
  }

  logger.info(`There are ${missingChapterFiles.length} new chapters for ${manga.title}`);

  await Promise.all(
    missingChapterFiles.map(async (chapterIndex) => {
      const job = await downloadQueue.getJob(`${sanitizer(manga.title)}_${chapterIndex}_download`);
      if (job) {
        await job.remove();
      }
    }),
  );

  await downloadQueue.addBulk(
    missingChapterFiles.map((chapterIndex) => ({
      opts: {
        jobId: `${sanitizer(manga.title)}_${chapterIndex}_download`,
      },
      name: `${sanitizer(manga.title)}_chapter#${chapterIndex}_download`,
      data: {
        manga,
        chapterIndex,
      },
    })),
  );
};

export const checkChaptersQueue = new Queue('checkChaptersQueue', {
  connection: {
    host: 'localhost',
    port: 6379,
  },
});

export const checkChaptersWorker = new Worker(
  'checkChaptersQueue',
  async (job: Job) => {
    const { manga }: { manga: MangaWithLibrary } = job.data;
    await checkChapters(manga);
    await job.updateProgress(100);
  },
  {
    concurrency: 5,
    connection: {
      host: 'localhost',
      port: 6379,
    },
  },
);

export const getJobIdFromTitle = (title: string) => `check_${sanitizer(title)}_chapters`;

export const removeJob = async (title: string) => {
  const jobId = getJobIdFromTitle(title);
  const jobs = await checkChaptersQueue.getJobs('delayed');
  await Promise.all(
    jobs
      .filter((job) => job.opts.repeat?.jobId === jobId)
      .map(async (job) => {
        if (job.id) {
          return checkChaptersQueue.remove(job.id);
        }
        return null;
      }),
  );
};

export const schedule = async (manga: MangaWithLibrary) => {
  if (manga.interval === 'never') {
    return;
  }

  await removeJob(manga.title);
  const jobId = getJobIdFromTitle(manga.title);

  await checkChaptersQueue.add(
    jobId,
    {
      manga,
    },
    {
      jobId,
      repeatJobKey: jobId,
      repeat: {
        pattern: cronMap[manga.interval as keyof typeof cronMap],
      },
    },
  );

  await checkChapters(manga);
};