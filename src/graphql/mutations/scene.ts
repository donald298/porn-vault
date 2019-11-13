import { database } from "../../database";
import Actor from "../../types/actor";
import Label from "../../types/label";
import {
  ReadStream,
  createWriteStream,
  statSync,
  existsSync,
  unlinkSync
} from "fs";
import { extname } from "path";
import Scene, { ThumbnailFile } from "../../types/scene";
import ffmpeg from "fluent-ffmpeg";
import * as logger from "../../logger";
import Image from "../../types/image";
import { getConfig } from "../../config";
import { extractLabels, extractActors } from "../../extractor";
import { Dictionary, libraryPath } from "../../types/utility";
import Movie from "../../types/movie";
import ora from "ora";

type ISceneUpdateOpts = Partial<{
  favorite: boolean;
  bookmark: boolean;
  actors: string[];
  name: string;
  description: string;
  rating: number;
  labels: string[];
  streamLinks: string[];
  thumbnail: string;
  releaseDate: number;
}>;

export default {
  watchScene(_, { id }: { id: string }) {
    const scene = Scene.getById(id);

    if (scene) {
      Scene.watch(scene);
      return scene;
    }
    return null;
  },

  addScene(_, args: Dictionary<any>) {
    for (const actor of args.actors || []) {
      const actorInDb = Actor.getById(actor);

      if (!actorInDb) throw new Error(`Actor ${actor} not found`);
    }

    for (const label of args.labels || []) {
      const labelInDb = Label.getById(label);

      if (!labelInDb) throw new Error(`Label ${label} not found`);
    }

    const sceneName = args.name;
    const scene = new Scene(sceneName);

    if (args.actors) {
      scene.actors = args.actors;
    }

    // Extract actors
    const extractedActors = extractActors(scene.name);
    logger.log(`Found ${extractedActors.length} actors in scene title.`);
    scene.actors.push(...extractedActors);
    scene.actors = [...new Set(scene.actors)];

    if (args.labels) {
      scene.labels = args.labels;
    }

    // Extract labels
    const extractedLabels = extractLabels(scene.name);
    logger.log(`Found ${extractedLabels.length} labels in scene title.`);
    scene.labels.push(...extractedLabels);
    scene.labels = [...new Set(scene.labels)];

    database
      .get("scenes")
      .push(scene)
      .write();

    logger.success(`Scene '${sceneName}' done.`);
    return scene;
  },

  async uploadScene(_, args: Dictionary<any>) {
    logger.log(`Receiving scene...`);

    for (const actor of args.actors || []) {
      const actorInDb = Actor.getById(actor);

      if (!actorInDb) throw new Error(`Actor ${actor} not found`);
    }

    for (const label of args.labels || []) {
      const labelInDb = Label.getById(label);

      if (!labelInDb) throw new Error(`Label ${label} not found`);
    }

    const { filename, mimetype, createReadStream } = await args.file;
    logger.log(`Receiving ${filename}...`);
    const ext = extname(filename);
    const fileNameWithoutExtension = filename.split(".")[0];

    let sceneName = fileNameWithoutExtension;

    if (args.name) sceneName = args.name;

    if (!mimetype.includes("video/")) throw new Error("Invalid file");

    const config = getConfig();

    if (!existsSync(config.FFMPEG_PATH)) {
      logger.error("FFMPEG not found");
      throw new Error("FFMPEG not found");
    }

    if (!existsSync(config.FFPROBE_PATH)) {
      logger.error("FFPROBE not found");
      throw new Error("FFPROBE not found");
    }

    ffmpeg.setFfmpegPath(config.FFMPEG_PATH);
    ffmpeg.setFfprobePath(config.FFPROBE_PATH);

    const scene = new Scene(sceneName);

    const sourcePath = `scenes/${scene.id}${ext}`;
    scene.path = sourcePath;

    logger.log(`Getting file...`);

    const read = createReadStream() as ReadStream;
    const write = createWriteStream(libraryPath(sourcePath));

    try {
      const pipe = read.pipe(write);

      await new Promise((resolve, reject) => {
        pipe.on("close", () => resolve());
      });
    } catch (error) {
      logger.error("Error reading file - perhaps a permission problem?");
      try {
        unlinkSync(libraryPath(sourcePath));
      } catch (error) {
        logger.warn(
          `Could not cleanup source file - ${libraryPath(sourcePath)}`
        );
      }
      throw new Error("Error");
    }

    // File written, now process
    logger.success(`File written to ${libraryPath(sourcePath)}.`);

    try {
      await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(libraryPath(sourcePath), (err, data) => {
          if (err) {
            console.log(err);
            return reject(err);
          }

          const meta = data.streams[0];
          const { size } = statSync(libraryPath(sourcePath));

          if (meta) {
            scene.meta.dimensions = {
              width: <any>meta.width || null,
              height: <any>meta.height || null
            };
            if (meta.duration) scene.meta.duration = parseInt(meta.duration);
          } else {
            logger.warn("Could not get video meta data.");
          }

          scene.meta.size = size;
          resolve();
        });
      });
    } catch (err) {
      logger.error("Error ffprobing file - perhaps a permission problem?");
      try {
        unlinkSync(libraryPath(sourcePath));
      } catch (error) {
        logger.warn(
          `Could not cleanup source file - ${libraryPath(sourcePath)}`
        );
      }
      throw new Error("Error");
    }

    if (args.actors) {
      scene.actors = args.actors;
    }

    // Extract actors
    const extractedActors = extractActors(scene.name);

    let extractedActorsFromFileName = [] as string[];
    if (args.name) extractedActorsFromFileName = extractActors(filename);

    scene.actors.push(...extractedActors);
    scene.actors.push(...extractedActorsFromFileName);
    scene.actors = [...new Set(scene.actors)];
    logger.log(`Found ${scene.actors.length} actors in scene title.`);

    if (args.labels) {
      scene.labels = args.labels;
    }

    // Extract labels
    const extractedLabels = extractLabels(scene.name);

    let extractedLabelsFromFileName = [] as string[];
    if (args.name) extractedLabelsFromFileName = extractLabels(filename);

    scene.labels.push(...extractedLabels);
    scene.labels.push(...extractedLabelsFromFileName);
    scene.labels = [...new Set(scene.labels)];
    logger.log(`Found ${scene.labels.length} labels in scene title.`);

    if (config.GENERATE_THUMBNAILS) {
      const loader = ora("Generating thumbnails...").start();

      let thumbnailFiles = [] as ThumbnailFile[];
      let images = [] as Image[];

      try {
        thumbnailFiles = await Scene.generateThumbnails(scene);
        for (let i = 0; i < thumbnailFiles.length; i++) {
          const file = thumbnailFiles[i];
          const image = new Image(`${sceneName} ${i + 1}`);
          image.path = file.path;
          image.scene = scene.id;
          image.meta.size = file.size;
          image.actors = scene.actors;
          image.labels = scene.labels;
          database
            .get("images")
            .push(image)
            .write();
          images.push(image);
        }
      } catch (error) {
        loader.fail(`Error generating thumbnails.`);
        throw error;
      }

      scene.thumbnail = images[Math.floor(images.length / 2)].id;
      loader.succeed(`Created ${thumbnailFiles.length} thumbnails.`);
    }

    database
      .get("scenes")
      .push(scene)
      .write();

    // Done

    logger.success(`Scene '${sceneName}' done.`);

    return scene;
  },

  addActorsToScene(_, { id, actors }: { id: string; actors: string[] }) {
    const scene = Scene.getById(id);

    if (scene) {
      if (Array.isArray(actors)) scene.actors.push(...actors);

      scene.actors = [...new Set(scene.actors)];

      database
        .get("scenes")
        .find({ id: scene.id })
        .assign(scene)
        .write();

      return scene;
    } else {
      throw new Error(`Scene ${id} not found`);
    }
  },

  updateScenes(_, { ids, opts }: { ids: string[]; opts: ISceneUpdateOpts }) {
    const updatedScenes = [] as Scene[];

    for (const id of ids) {
      const scene = Scene.getById(id);

      if (scene) {
        if (typeof opts.name == "string") scene.name = opts.name;

        if (typeof opts.description == "string")
          scene.description = opts.description;

        if (typeof opts.thumbnail == "string") scene.thumbnail = opts.thumbnail;

        if (Array.isArray(opts.actors)) scene.actors = opts.actors;

        if (Array.isArray(opts.labels)) scene.labels = opts.labels;

        if (Array.isArray(opts.streamLinks))
          scene.streamLinks = opts.streamLinks;

        if (typeof opts.bookmark == "boolean") scene.bookmark = opts.bookmark;

        if (typeof opts.favorite == "boolean") scene.favorite = opts.favorite;

        if (typeof opts.rating == "number") scene.rating = opts.rating;

        if (typeof opts.releaseDate == "number")
          scene.releaseDate = opts.releaseDate;

        database
          .get("scenes")
          .find({ id: scene.id })
          .assign(scene)
          .write();

        updatedScenes.push(scene);
      }
    }

    return updatedScenes;
  },

  removeScenes(_, { ids }: { ids: string[] }) {
    for (const id of ids) {
      const scene = Scene.getById(id);

      if (scene) {
        Scene.remove(scene.id);

        Movie.filterScene(scene.id);

        return true;
      }
    }
  }
};
