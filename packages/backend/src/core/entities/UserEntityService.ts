import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { In, Not } from 'typeorm';
import Ajv from 'ajv';
import { ModuleRef } from '@nestjs/core';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { Packed } from '@/misc/schema.js';
import type { Promiseable } from '@/misc/prelude/await-all.js';
import { awaitAll } from '@/misc/prelude/await-all.js';
import { USER_ACTIVE_THRESHOLD, USER_ONLINE_THRESHOLD } from '@/const.js';
import { Cache } from '@/misc/cache.js';
import type { Instance } from '@/models/entities/Instance.js';
import type { ILocalUser, IRemoteUser, User } from '@/models/entities/User.js';
import { birthdaySchema, descriptionSchema, localUsernameSchema, locationSchema, nameSchema, passwordSchema } from '@/models/entities/User.js';
import type { UsersRepository, UserSecurityKeysRepository, FollowingsRepository, FollowRequestsRepository, BlockingsRepository, MutingsRepository, DriveFilesRepository, NoteUnreadsRepository, ChannelFollowingsRepository, NotificationsRepository, UserNotePiningsRepository, UserProfilesRepository, InstancesRepository, AnnouncementReadsRepository, MessagingMessagesRepository, UserGroupJoiningsRepository, AnnouncementsRepository, AntennaNotesRepository, PagesRepository } from '@/models/index.js';
import type { OnModuleInit } from '@nestjs/common';
import type { AntennaService } from '../AntennaService.js';
import type { CustomEmojiService } from '../CustomEmojiService.js';
import type { NoteEntityService } from './NoteEntityService.js';
import type { DriveFileEntityService } from './DriveFileEntityService.js';
import type { PageEntityService } from './PageEntityService.js';

type IsUserDetailed<Detailed extends boolean> = Detailed extends true ? Packed<'UserDetailed'> : Packed<'UserLite'>;
type IsMeAndIsUserDetailed<ExpectsMe extends boolean | null, Detailed extends boolean> =
	Detailed extends true ? 
		ExpectsMe extends true ? Packed<'MeDetailed'> :
		ExpectsMe extends false ? Packed<'UserDetailedNotMe'> :
		Packed<'UserDetailed'> :
	Packed<'UserLite'>;

const ajv = new Ajv();

function isLocalUser(user: User): user is ILocalUser;
function isLocalUser<T extends { host: User['host'] }>(user: T): user is T & { host: null; };
function isLocalUser(user: User | { host: User['host'] }): boolean {
	return user.host == null;
}

function isRemoteUser(user: User): user is IRemoteUser;
function isRemoteUser<T extends { host: User['host'] }>(user: T): user is T & { host: string; };
function isRemoteUser(user: User | { host: User['host'] }): boolean {
	return !isLocalUser(user);
}

@Injectable()
export class UserEntityService implements OnModuleInit {
	private noteEntityService: NoteEntityService;
	private driveFileEntityService: DriveFileEntityService;
	private pageEntityService: PageEntityService;
	private customEmojiService: CustomEmojiService;
	private antennaService: AntennaService;
	private userInstanceCache: Cache<Instance | null>;

	constructor(
		private moduleRef: ModuleRef,

		@Inject(DI.config)
		private config: Config,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.userSecurityKeysRepository)
		private userSecurityKeysRepository: UserSecurityKeysRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		@Inject(DI.followRequestsRepository)
		private followRequestsRepository: FollowRequestsRepository,

		@Inject(DI.blockingsRepository)
		private blockingsRepository: BlockingsRepository,

		@Inject(DI.mutingsRepository)
		private mutingsRepository: MutingsRepository,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		@Inject(DI.noteUnreadsRepository)
		private noteUnreadsRepository: NoteUnreadsRepository,

		@Inject(DI.channelFollowingsRepository)
		private channelFollowingsRepository: ChannelFollowingsRepository,

		@Inject(DI.notificationsRepository)
		private notificationsRepository: NotificationsRepository,

		@Inject(DI.userNotePiningsRepository)
		private userNotePiningsRepository: UserNotePiningsRepository,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		@Inject(DI.announcementReadsRepository)
		private announcementReadsRepository: AnnouncementReadsRepository,

		@Inject(DI.messagingMessagesRepository)
		private messagingMessagesRepository: MessagingMessagesRepository,

		@Inject(DI.userGroupJoiningsRepository)
		private userGroupJoiningsRepository: UserGroupJoiningsRepository,

		@Inject(DI.announcementsRepository)
		private announcementsRepository: AnnouncementsRepository,

		@Inject(DI.antennaNotesRepository)
		private antennaNotesRepository: AntennaNotesRepository,

		@Inject(DI.pagesRepository)
		private pagesRepository: PagesRepository,

		//private noteEntityService: NoteEntityService,
		//private driveFileEntityService: DriveFileEntityService,
		//private pageEntityService: PageEntityService,
		//private customEmojiService: CustomEmojiService,
		//private antennaService: AntennaService,
	) {
		this.userInstanceCache = new Cache<Instance | null>(1000 * 60 * 60 * 3);
	}

	onModuleInit() {
		this.noteEntityService = this.moduleRef.get('NoteEntityService');
		this.driveFileEntityService = this.moduleRef.get('DriveFileEntityService');
		this.pageEntityService = this.moduleRef.get('PageEntityService');
		this.customEmojiService = this.moduleRef.get('CustomEmojiService');
		this.antennaService = this.moduleRef.get('AntennaService');
	}

	//#region Validators
	public validateLocalUsername = ajv.compile(localUsernameSchema);
	public validatePassword = ajv.compile(passwordSchema);
	public validateName = ajv.compile(nameSchema);
	public validateDescription = ajv.compile(descriptionSchema);
	public validateLocation = ajv.compile(locationSchema);
	public validateBirthday = ajv.compile(birthdaySchema);
	//#endregion

	public isLocalUser = isLocalUser;
	public isRemoteUser = isRemoteUser;

	public async getRelation(me: User['id'], target: User['id']) {
		return awaitAll({
			id: target,
			isFollowing: this.followingsRepository.count({
				where: {
					followerId: me,
					followeeId: target,
				},
				take: 1,
			}).then(n => n > 0),
			isFollowed: this.followingsRepository.count({
				where: {
					followerId: target,
					followeeId: me,
				},
				take: 1,
			}).then(n => n > 0),
			hasPendingFollowRequestFromYou: this.followRequestsRepository.count({
				where: {
					followerId: me,
					followeeId: target,
				},
				take: 1,
			}).then(n => n > 0),
			hasPendingFollowRequestToYou: this.followRequestsRepository.count({
				where: {
					followerId: target,
					followeeId: me,
				},
				take: 1,
			}).then(n => n > 0),
			isBlocking: this.blockingsRepository.count({
				where: {
					blockerId: me,
					blockeeId: target,
				},
				take: 1,
			}).then(n => n > 0),
			isBlocked: this.blockingsRepository.count({
				where: {
					blockerId: target,
					blockeeId: me,
				},
				take: 1,
			}).then(n => n > 0),
			isMuted: this.mutingsRepository.count({
				where: {
					muterId: me,
					muteeId: target,
				},
				take: 1,
			}).then(n => n > 0),
		});
	}

	public async getHasUnreadMessagingMessage(userId: User['id']): Promise<boolean> {
		const mute = await this.mutingsRepository.findBy({
			muterId: userId,
		});

		const joinings = await this.userGroupJoiningsRepository.findBy({ userId: userId });

		const groupQs = Promise.all(joinings.map(j => this.messagingMessagesRepository.createQueryBuilder('message')
			.where('message.groupId = :groupId', { groupId: j.userGroupId })
			.andWhere('message.userId != :userId', { userId: userId })
			.andWhere('NOT (:userId = ANY(message.reads))', { userId: userId })
			.andWhere('message.createdAt > :joinedAt', { joinedAt: j.createdAt }) // 自分が加入する前の会話については、未読扱いしない
			.getOne().then(x => x != null)));

		const [withUser, withGroups] = await Promise.all([
			this.messagingMessagesRepository.count({
				where: {
					recipientId: userId,
					isRead: false,
					...(mute.length > 0 ? { userId: Not(In(mute.map(x => x.muteeId))) } : {}),
				},
				take: 1,
			}).then(count => count > 0),
			groupQs,
		]);

		return withUser || withGroups.some(x => x);
	}

	public async getHasUnreadAnnouncement(userId: User['id']): Promise<boolean> {
		const reads = await this.announcementReadsRepository.findBy({
			userId: userId,
		});

		const count = await this.announcementsRepository.countBy(reads.length > 0 ? {
			id: Not(In(reads.map(read => read.announcementId))),
		} : {});

		return count > 0;
	}

	public async getHasUnreadAntenna(userId: User['id']): Promise<boolean> {
		const myAntennas = (await this.antennaService.getAntennas()).filter(a => a.userId === userId);

		const unread = myAntennas.length > 0 ? await this.antennaNotesRepository.findOneBy({
			antennaId: In(myAntennas.map(x => x.id)),
			read: false,
		}) : null;

		return unread != null;
	}

	public async getHasUnreadChannel(userId: User['id']): Promise<boolean> {
		const channels = await this.channelFollowingsRepository.findBy({ followerId: userId });

		const unread = channels.length > 0 ? await this.noteUnreadsRepository.findOneBy({
			userId: userId,
			noteChannelId: In(channels.map(x => x.followeeId)),
		}) : null;

		return unread != null;
	}

	public async getHasUnreadNotification(userId: User['id']): Promise<boolean> {
		const mute = await this.mutingsRepository.findBy({
			muterId: userId,
		});
		const mutedUserIds = mute.map(m => m.muteeId);

		const count = await this.notificationsRepository.count({
			where: {
				notifieeId: userId,
				...(mutedUserIds.length > 0 ? { notifierId: Not(In(mutedUserIds)) } : {}),
				isRead: false,
			},
			take: 1,
		});

		return count > 0;
	}

	public async getHasPendingReceivedFollowRequest(userId: User['id']): Promise<boolean> {
		const count = await this.followRequestsRepository.countBy({
			followeeId: userId,
		});

		return count > 0;
	}

	public getOnlineStatus(user: User): 'unknown' | 'online' | 'active' | 'offline' {
		if (user.hideOnlineStatus) return 'unknown';
		if (user.lastActiveDate == null) return 'unknown';
		const elapsed = Date.now() - user.lastActiveDate.getTime();
		return (
			elapsed < USER_ONLINE_THRESHOLD ? 'online' :
			elapsed < USER_ACTIVE_THRESHOLD ? 'active' :
			'offline'
		);
	}

	public async getAvatarUrl(user: User): Promise<string> {
		if (user.avatar) {
			return this.driveFileEntityService.getPublicUrl(user.avatar, true) ?? this.getIdenticonUrl(user.id);
		} else if (user.avatarId) {
			const avatar = await this.driveFilesRepository.findOneByOrFail({ id: user.avatarId });
			return this.driveFileEntityService.getPublicUrl(avatar, true) ?? this.getIdenticonUrl(user.id);
		} else {
			return this.getIdenticonUrl(user.id);
		}
	}

	public getAvatarUrlSync(user: User): string {
		if (user.avatar) {
			return this.driveFileEntityService.getPublicUrl(user.avatar, true) ?? this.getIdenticonUrl(user.id);
		} else {
			return this.getIdenticonUrl(user.id);
		}
	}

	public getIdenticonUrl(userId: User['id']): string {
		return `${this.config.url}/identicon/${userId}`;
	}

	public async pack<ExpectsMe extends boolean | null = null, D extends boolean = false>(
		src: User['id'] | User,
		me?: { id: User['id'] } | null | undefined,
		options?: {
			detail?: D,
			includeSecrets?: boolean,
		},
	): Promise<IsMeAndIsUserDetailed<ExpectsMe, D>> {
		const opts = Object.assign({
			detail: false,
			includeSecrets: false,
		}, options);

		let user: User;

		if (typeof src === 'object') {
			user = src;
			if (src.avatar === undefined && src.avatarId) src.avatar = await this.driveFilesRepository.findOneBy({ id: src.avatarId }) ?? null;
			if (src.banner === undefined && src.bannerId) src.banner = await this.driveFilesRepository.findOneBy({ id: src.bannerId }) ?? null;
		} else {
			user = await this.usersRepository.findOneOrFail({
				where: { id: src },
				relations: {
					avatar: true,
					banner: true,
				},
			});
		}

		const meId = me ? me.id : null;
		const isMe = meId === user.id;

		const relation = meId && !isMe && opts.detail ? await this.getRelation(meId, user.id) : null;
		const pins = opts.detail ? await this.userNotePiningsRepository.createQueryBuilder('pin')
			.where('pin.userId = :userId', { userId: user.id })
			.innerJoinAndSelect('pin.note', 'note')
			.orderBy('pin.id', 'DESC')
			.getMany() : [];
		const profile = opts.detail ? await this.userProfilesRepository.findOneByOrFail({ userId: user.id }) : null;

		const followingCount = profile == null ? null :
			(profile.ffVisibility === 'public') || isMe ? user.followingCount :
			(profile.ffVisibility === 'followers') && (relation && relation.isFollowing) ? user.followingCount :
			null;

		const followersCount = profile == null ? null :
			(profile.ffVisibility === 'public') || isMe ? user.followersCount :
			(profile.ffVisibility === 'followers') && (relation && relation.isFollowing) ? user.followersCount :
			null;

		const falsy = opts.detail ? false : undefined;

		const packed = {
			id: user.id,
			name: user.name,
			username: user.username,
			host: user.host,
			avatarUrl: this.getAvatarUrlSync(user),
			avatarBlurhash: user.avatar?.blurhash ?? null,
			avatarColor: null, // 後方互換性のため
			isAdmin: user.isAdmin ?? falsy,
			isModerator: user.isModerator ?? falsy,
			isBot: user.isBot ?? falsy,
			isCat: user.isCat ?? falsy,
			instance: user.host ? this.userInstanceCache.fetch(user.host,
				() => this.instancesRepository.findOneBy({ host: user.host! }),
				v => v != null,
			).then(instance => instance ? {
				name: instance.name,
				softwareName: instance.softwareName,
				softwareVersion: instance.softwareVersion,
				iconUrl: instance.iconUrl,
				faviconUrl: instance.faviconUrl,
				themeColor: instance.themeColor,
			} : undefined) : undefined,
			emojis: this.customEmojiService.populateEmojis(user.emojis, user.host),
			onlineStatus: this.getOnlineStatus(user),
			driveCapacityOverrideMb: user.driveCapacityOverrideMb,

			...(opts.detail ? {
				url: profile!.url,
				uri: user.uri,
				createdAt: user.createdAt.toISOString(),
				updatedAt: user.updatedAt ? user.updatedAt.toISOString() : null,
				lastFetchedAt: user.lastFetchedAt ? user.lastFetchedAt.toISOString() : null,
				bannerUrl: user.banner ? this.driveFileEntityService.getPublicUrl(user.banner, false) : null,
				bannerBlurhash: user.banner?.blurhash ?? null,
				bannerColor: null, // 後方互換性のため
				isLocked: user.isLocked,
				isSilenced: user.isSilenced ?? falsy,
				isSuspended: user.isSuspended ?? falsy,
				description: profile!.description,
				location: profile!.location,
				birthday: profile!.birthday,
				lang: profile!.lang,
				fields: profile!.fields,
				followersCount: followersCount ?? 0,
				followingCount: followingCount ?? 0,
				notesCount: user.notesCount,
				pinnedNoteIds: pins.map(pin => pin.noteId),
				pinnedNotes: this.noteEntityService.packMany(pins.map(pin => pin.note!), me, {
					detail: true,
				}),
				pinnedPageId: profile!.pinnedPageId,
				pinnedPage: profile!.pinnedPageId ? this.pageEntityService.pack(profile!.pinnedPageId, me) : null,
				publicReactions: profile!.publicReactions,
				ffVisibility: profile!.ffVisibility,
				twoFactorEnabled: profile!.twoFactorEnabled,
				usePasswordLessLogin: profile!.usePasswordLessLogin,
				securityKeys: profile!.twoFactorEnabled
					? this.userSecurityKeysRepository.countBy({
						userId: user.id,
					}).then(result => result >= 1)
					: false,
			} : {}),

			...(opts.detail && isMe ? {
				avatarId: user.avatarId,
				bannerId: user.bannerId,
				injectFeaturedNote: profile!.injectFeaturedNote,
				receiveAnnouncementEmail: profile!.receiveAnnouncementEmail,
				alwaysMarkNsfw: profile!.alwaysMarkNsfw,
				autoSensitive: profile!.autoSensitive,
				carefulBot: profile!.carefulBot,
				autoAcceptFollowed: profile!.autoAcceptFollowed,
				noCrawle: profile!.noCrawle,
				isExplorable: user.isExplorable,
				isDeleted: user.isDeleted,
				hideOnlineStatus: user.hideOnlineStatus,
				hasUnreadSpecifiedNotes: this.noteUnreadsRepository.count({
					where: { userId: user.id, isSpecified: true },
					take: 1,
				}).then(count => count > 0),
				hasUnreadMentions: this.noteUnreadsRepository.count({
					where: { userId: user.id, isMentioned: true },
					take: 1,
				}).then(count => count > 0),
				hasUnreadAnnouncement: this.getHasUnreadAnnouncement(user.id),
				hasUnreadAntenna: this.getHasUnreadAntenna(user.id),
				hasUnreadChannel: this.getHasUnreadChannel(user.id),
				hasUnreadMessagingMessage: this.getHasUnreadMessagingMessage(user.id),
				hasUnreadNotification: this.getHasUnreadNotification(user.id),
				hasPendingReceivedFollowRequest: this.getHasPendingReceivedFollowRequest(user.id),
				integrations: profile!.integrations,
				mutedWords: profile!.mutedWords,
				mutedInstances: profile!.mutedInstances,
				mutingNotificationTypes: profile!.mutingNotificationTypes,
				emailNotificationTypes: profile!.emailNotificationTypes,
				showTimelineReplies: user.showTimelineReplies ?? falsy,
			} : {}),

			...(opts.includeSecrets ? {
				email: profile!.email,
				emailVerified: profile!.emailVerified,
				securityKeysList: profile!.twoFactorEnabled
					? this.userSecurityKeysRepository.find({
						where: {
							userId: user.id,
						},
						select: {
							id: true,
							name: true,
							lastUsed: true,
						},
					})
					: [],
			} : {}),

			...(relation ? {
				isFollowing: relation.isFollowing,
				isFollowed: relation.isFollowed,
				hasPendingFollowRequestFromYou: relation.hasPendingFollowRequestFromYou,
				hasPendingFollowRequestToYou: relation.hasPendingFollowRequestToYou,
				isBlocking: relation.isBlocking,
				isBlocked: relation.isBlocked,
				isMuted: relation.isMuted,
			} : {}),
		} as Promiseable<Packed<'User'>> as Promiseable<IsMeAndIsUserDetailed<ExpectsMe, D>>;

		return await awaitAll(packed);
	}

	public packMany<D extends boolean = false>(
		users: (User['id'] | User)[],
		me?: { id: User['id'] } | null | undefined,
		options?: {
			detail?: D,
			includeSecrets?: boolean,
		},
	): Promise<IsUserDetailed<D>[]> {
		return Promise.all(users.map(u => this.pack(u, me, options)));
	}
}
