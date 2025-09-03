import * as Tooltip from '@radix-ui/react-tooltip';
import { classNames } from '~/utils/classNames';
import type { TabVisibilityConfig } from '~/components/@settings/core/types';
import { TAB_LABELS, TAB_ICONS } from '~/components/@settings/core/constants';
import { GlowingEffect } from '~/components/ui/GlowingEffect';

interface TabTileProps {
  tab: TabVisibilityConfig;
  onClick?: () => void;
  isActive?: boolean;
  hasUpdate?: boolean;
  statusMessage?: string;
  description?: string;
  isLoading?: boolean;
  className?: string;
  children?: React.ReactNode;
}

export const TabTile: React.FC<TabTileProps> = ({
  tab,
  onClick,
  isActive,
  hasUpdate,
  statusMessage,
  description,
  isLoading,
  className,
  children,
}: TabTileProps) => {
  return (
    <Tooltip.Provider delayDuration={0}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <div className={classNames('min-h-[160px] list-none', className || '')}>
            <div className="relative h-full rounded-xl border border-bolt-elements-borderColor p-0.5">
              <GlowingEffect
                blur={0}
                borderWidth={1}
                spread={20}
                glow={true}
                disabled={false}
                proximity={40}
                inactiveZone={0.3}
                movementDuration={0.4}
              />
              <div
                onClick={onClick}
                className={classNames(
                  'relative flex flex-col items-center justify-center h-full p-4 rounded-lg',
                  'bg-bolt-elements-bg-depth-1',
                  'group cursor-pointer',
                  'hover:bg-bolt-elements-item-backgroundActive',
                  'transition-colors duration-100 ease-out',
                  isActive ? 'bg-bolt-elements-item-backgroundAccent/10' : '',
                  isLoading ? 'cursor-wait opacity-70 pointer-events-none' : '',
                )}
              >
                {/* Icon */}
                <div
                  className={classNames(
                    'relative',
                    'w-14 h-14',
                    'flex items-center justify-center',
                    'rounded-xl',
                    'bg-bolt-elements-bg-depth-2',
                    'ring-1 ring-bolt-elements-borderColor',
                    'group-hover:bg-bolt-elements-item-backgroundActive',
                    'group-hover:ring-bolt-elements-borderColorActive',
                    'transition-all duration-100 ease-out',
                    isActive ? 'bg-bolt-elements-item-backgroundAccent/20 ring-bolt-elements-borderColorActive' : '',
                  )}
                >
                  {(() => {
                    const IconComponent = TAB_ICONS[tab.id];
                    return (
                      <IconComponent
                        className={classNames(
                          'w-8 h-8',
                          'text-bolt-elements-textSecondary',
                          'group-hover:text-bolt-elements-item-contentActive',
                          'transition-colors duration-100 ease-out',
                          isActive ? 'text-bolt-elements-item-contentAccent' : '',
                        )}
                      />
                    );
                  })()}
                </div>

                {/* Label and Description */}
                <div className="flex flex-col items-center mt-4 w-full">
                  <h3
                    className={classNames(
                      'text-[15px] font-medium leading-snug mb-2',
                      'text-bolt-elements-textPrimary',
                      'group-hover:text-bolt-elements-item-contentActive',
                      'transition-colors duration-100 ease-out',
                      isActive ? 'text-bolt-elements-item-contentAccent' : '',
                    )}
                  >
                    {TAB_LABELS[tab.id]}
                  </h3>
                  {description && (
                    <p
                      className={classNames(
                        'text-[13px] leading-relaxed',
                        'text-bolt-elements-textTertiary',
                        'max-w-[85%]',
                        'text-center',
                        'group-hover:text-bolt-elements-item-contentActive/80',
                        'transition-colors duration-100 ease-out',
                        isActive ? 'text-bolt-elements-item-contentAccent/90' : '',
                      )}
                    >
                      {description}
                    </p>
                  )}
                </div>

                {/* Update Indicator with Tooltip */}
                {hasUpdate && (
                  <>
                    <div className="absolute top-4 right-4 w-2 h-2 rounded-full bg-bolt-elements-item-contentAccent animate-pulse" />
                    <Tooltip.Portal>
                      <Tooltip.Content
                        className={classNames(
                          'px-3 py-1.5 rounded-lg',
                          'bg-bolt-elements-bg-depth-2 text-bolt-elements-textPrimary',
                          'border border-bolt-elements-borderColor',
                          'text-sm font-medium',
                          'select-none',
                          'z-[100]',
                        )}
                        side="top"
                        sideOffset={5}
                      >
                        {statusMessage}
                        <Tooltip.Arrow className="fill-bolt-elements-bg-depth-2" />
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </>
                )}

                {/* Children (e.g. Beta Label) */}
                {children}
              </div>
            </div>
          </div>
        </Tooltip.Trigger>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
};
