import Controller from '@ember/controller';
import { action } from '@ember/object';
import { inject as service } from '@ember/service';
import { task, all } from 'ember-concurrency';
import { TrackItemState } from '../models/track-item';

export default class PlaylistController extends Controller {
  @service tunesfer;

  get additionalTracksAvailable() {
    return this.model.playlist.tracks.total - this.model.playlist.tracks.items.length;
  }

  /**
   * Task to authorize the user with Apple Music.
   */
  @(task(function *() {
    yield this.tunesfer.authorize();
    this.notifyPropertyChange('isAuthorized');
  })) authorize;

  /**
   * Task to add the playlist to the user's library.
   */
  @(task(function *() {
    if (!this.tunesfer.isAuthorized) {
      throw new Error('The user is unauthorized!');
    }

    // If required, fetch the full playlist from Spotify and swap out the model.
    if (this.model.playlist.tracks.total > 100) {
      const spotifyPlaylist = yield this.tunesfer.getSpotifyPlaylist(this.model.playlist.id, true);
      this.model = { playlist: spotifyPlaylist };
    }

    // Check if the playlist exists in the library.
    let playlist = yield this.tunesfer.findPlaylist(this.model.playlist.name);
    if (!playlist) {
      playlist = yield this.tunesfer.createPlaylist(this.model.playlist.name);
    } else {
      // Fetch the full playlist.
      playlist = yield this.tunesfer.getPlaylist(playlist.id);
    }

    // Create tasks for each of the tracks.
    let tasks = this.model.playlist.tracks.items.map((trackItem => {
      trackItem.state = TrackItemState.IDLE;
      trackItem.task = this.processTrack.perform(trackItem, playlist);
      return trackItem.task;
    }));

    // Wait for it all to complete.
    yield all(tasks);
  })).restartable() addPlaylist;

  /**
   * Task to add a track to a playlist.
   */
  @(task(function * (trackItem, playlist) {
    trackItem.state = TrackItemState.PROCESSING;

    // Do a simple check to see if the track already exists in the playlist.
    if (playlist.tracks.find((playlistTrack) => {
      return trackItem.track.artists[0].name === playlistTrack.attributes.artistName
        && trackItem.track.name === playlistTrack.attributes.name;
    })) {
      trackItem.state = TrackItemState.SKIPPED;
      return;
    }

    // Find the track.
    const track = yield this.tunesfer.findSpotifySong(trackItem.track);
    if (!track) {
      trackItem.state = TrackItemState.NOT_FOUND;
      return;
    }

    // See if the track already exists in the playlist.
    if (playlist.tracks.find((playlistTrack) => {
      return track.attributes.name === playlistTrack.attributes.name;
    })) {
      trackItem.state = TrackItemState.SKIPPED;
      return;
    }

    // Add the track to the playlist.
    try {
      const result = yield this.tunesfer.addSongToPlaylist(track, playlist);
      if (!result) {
        trackItem.state = TrackItemState.FAILED;
        return;
      }
      trackItem.state = TrackItemState.DONE;
    } catch {
      trackItem.state = TrackItemState.FAILED;
    }
  })).enqueue() processTrack;

  @action
  cancel() {
    this.addPlaylist.cancelAll();
    this.processTrack.cancelAll();

    // Reset track state.
    for (const trackItem of this.model.playlist.tracks.items) {
      if (trackItem.state === TrackItemState.IDLE || trackItem.state === TrackItemState.PROCESSING) {
        trackItem.state = TrackItemState.CANCELLED;
      }
    }
  }
}
